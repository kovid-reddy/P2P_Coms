const http = require("http");
const WebSocket = require("ws");

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const MAX_PAYLOAD_BYTES = Number.parseInt(process.env.MAX_SIGNALING_MESSAGE_BYTES, 10) || 64 * 1024;
const MAX_MESSAGES_PER_WINDOW = Number.parseInt(process.env.MAX_MESSAGES_PER_WINDOW, 10) || 60;
const RATE_WINDOW_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean));
const PEER_ID_RE = /^[a-f0-9]{64}$/i;
const peers = new Map();

function log(event, fields = {}) {
    // Never log SDP, ICE candidates, credentials, or any application payload.
    console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

function isOriginAllowed(request) {
    const origin = request.headers.origin;
    if (!origin) return true; // Non-browser health tools / local test clients.
    if (ALLOWED_ORIGINS.has(origin)) return true;
    try {
        // The local and same-LAN client are normally served from the same host
        // as signaling (the port may differ), so allow that same host only.
        const originUrl = new URL(origin);
        const requestHost = (request.headers.host || "").split(":")[0].toLowerCase();
        return originUrl.hostname.toLowerCase() === requestHost;
    } catch {
        return false;
    }
}

function send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function removePeer(ws, reason) {
    const peerId = ws.peerId;
    if (!peerId || peers.get(peerId)?.ws !== ws) return;
    peers.delete(peerId);
    log("peer_disconnected", { peerId: peerId.slice(0, 12), reason });
    for (const peer of peers.values()) send(peer.ws, { type: "peer-left", peerId });
}

function broadcastPeerJoined(peerId, info, excludeWs) {
    for (const peer of peers.values()) {
        if (peer.ws !== excludeWs) send(peer.ws, { type: "peer-joined", peerId, info });
    }
}

function validateMessage(data) {
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.type !== "string") return "Invalid message format";
    if (!new Set(["register", "discover", "offer", "answer", "candidate"]).has(data.type)) return "Unsupported message type";
    if (["offer", "answer", "candidate"].includes(data.type) && (!data[data.type] || typeof data[data.type] !== "object")) {
        return `Invalid ${data.type} payload`;
    }
    return null;
}

const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    }
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/status")) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ status: "ok", uptimeSeconds: Math.floor(process.uptime()), registeredPeers: peers.size, connectedSockets: wss.clients.size, timestamp: new Date().toISOString() }));
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("P2P signaling server. Use WebSocket or GET /health.");
});

const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
    if (!["/", "/ws"].includes(pathname) || !isOriginAllowed(request)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return socket.destroy();
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) {
            log("socket_terminated", { peerId: ws.peerId?.slice(0, 12) || "unregistered" });
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, HEARTBEAT_INTERVAL_MS);

wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.peerId = null;
    ws.rateWindowStarted = Date.now();
    ws.messageCount = 0;
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (raw) => {
        const now = Date.now();
        if (now - ws.rateWindowStarted >= RATE_WINDOW_MS) {
            ws.rateWindowStarted = now;
            ws.messageCount = 0;
        }
        ws.messageCount += 1;
        if (ws.messageCount > MAX_MESSAGES_PER_WINDOW) {
            log("rate_limited", { peerId: ws.peerId?.slice(0, 12) || "unregistered" });
            send(ws, { type: "error", message: "Rate limit exceeded" });
            return ws.close(1008, "Rate limit exceeded");
        }

        let data;
        try { data = JSON.parse(raw.toString()); } catch {
            log("malformed_message", { peerId: ws.peerId?.slice(0, 12) || "unregistered" });
            return send(ws, { type: "error", message: "Malformed JSON payload" });
        }
        const validationError = validateMessage(data);
        if (validationError) return send(ws, { type: "error", message: validationError });

        if (data.type === "register") {
            if (!PEER_ID_RE.test(data.peerId || "")) return send(ws, { type: "error", message: "Invalid peer ID" });
            if (ws.peerId && ws.peerId !== data.peerId) return send(ws, { type: "error", message: "Peer ID cannot change" });
            const existing = peers.get(data.peerId);
            if (existing && existing.ws !== ws) {
                existing.ws.peerId = null;
                existing.ws.close(4001, "Replaced by newer connection");
                log("duplicate_peer_replaced", { peerId: data.peerId.slice(0, 12) });
            }
            ws.peerId = data.peerId;
            const info = typeof data.info === "string" ? data.info.slice(0, 128) : "webrtc";
            peers.set(data.peerId, { ws, info });
            broadcastPeerJoined(data.peerId, info, ws);
            return log("peer_registered", { peerId: data.peerId.slice(0, 12) });
        }

        if (!ws.peerId) return send(ws, { type: "error", message: "Register before sending signaling messages" });
        if (data.type === "discover") {
            const peerList = [...peers.entries()].filter(([peerId]) => peerId !== ws.peerId).map(([peerId, peer]) => ({ peerId, info: peer.info }));
            return send(ws, { type: "peer-list", peers: peerList });
        }

        if (!PEER_ID_RE.test(data.target || "")) return send(ws, { type: "error", message: "Invalid target peer ID" });
        const target = peers.get(data.target);
        if (!target || target.ws.readyState !== WebSocket.OPEN) return send(ws, { type: "error", message: "Target peer is unavailable", target: data.target });
        // The server owns `from`; clients cannot impersonate another peer.
        send(target.ws, { type: data.type, from: ws.peerId, target: data.target, [data.type]: data[data.type] });
        log("signal_relayed", { type: data.type, from: ws.peerId.slice(0, 12), target: data.target.slice(0, 12) });
    });

    ws.on("close", (code) => removePeer(ws, `close_${code}`));
    ws.on("error", () => log("socket_error", { peerId: ws.peerId?.slice(0, 12) || "unregistered" }));
});

function shutdown(signal) {
    log("shutdown_started", { signal });
    clearInterval(heartbeatInterval);
    for (const client of wss.clients) client.close(1001, "Server shutting down");
    server.close(() => { log("shutdown_complete"); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
server.listen(PORT, HOST, () => log("server_started", { host: HOST, port: PORT, allowedOrigins: ALLOWED_ORIGINS.size }));
