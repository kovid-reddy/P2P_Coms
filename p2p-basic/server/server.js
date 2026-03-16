const WebSocket = require("ws");
const wss = new WebSocket.Server({ port: 3000 });
let peers = new Map();

wss.on("connection", (ws) => {
    ws.on("message", (msg) => {
        const data = JSON.parse(msg);
        // Peer registration
        if (data.type === "register") {
            peers.set(data.peerId, {
                ws: ws,
                info: data.info
            });
            console.log("Peer registered:", data.peerId);
        }
        // Peer discovery
        if (data.type === "discover") {
            const peerList = [];
            peers.forEach((value, key) => {
                if (value.ws !== ws) {
                    peerList.push({
                        peerId: key,
                        info: value.info
                    });
                }
            });
            ws.send(JSON.stringify({
                type: "peer-list",
                peers: peerList
            }));
        }
        // Route signaling messages
        if (data.type === "offer" || data.type === "answer" || data.type === "candidate") {
            const targetPeer = peers.get(data.target);
            if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
                targetPeer.ws.send(JSON.stringify(data));
            }
        }
    });
    ws.on("close", () => {
        for (let [key, value] of peers.entries()) {
            if (value.ws === ws) {
                peers.delete(key);
                console.log("Peer removed:", key);
            }
        }
    });
});
console.log("Bootstrap node running on ws://localhost:3000");