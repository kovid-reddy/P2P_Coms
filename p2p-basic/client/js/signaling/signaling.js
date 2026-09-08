import { CONFIG } from "../core/config.js";
import { getMyId } from "../core/identity.js";
import { discoveredPeers, peers } from "../core/state.js";
import { cleanupPeer } from "../transfer/transferCleanup.js";
import { createPeerConnection, addOrQueueIceCandidate, flushQueuedIceCandidates } from "../webrtc/peerConnection.js";

let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let intentionallyClosed = false;
let callbacks = {};
let heartbeatTimer = null;
const HEARTBEAT_INTERVAL_MS = 60_000;

function scheduleReconnect() {
    if (intentionallyClosed || reconnectTimer) return;
    const delay = Math.min(1_000 * (2 ** reconnectAttempt), 15_000);
    reconnectAttempt += 1;
    callbacks.onReconnecting?.(delay);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

function connect() {
    callbacks.onConnecting?.();
    try {
        socket = new WebSocket(CONFIG.SIGNALING_URL);
    } catch (error) {
        console.error("Signaling configuration error:", error.message);
        callbacks.onDisconnected?.(error);
        scheduleReconnect();
        return;
    }

    socket.onopen = () => {
        reconnectAttempt = 0;
        const myId = getMyId();
        if (myId) {
            sendSignaling({ type: "register", peerId: myId, info: "webrtc" });
            callbacks.onDiscovering?.();
            sendSignaling({ type: "discover" });
        }
        callbacks.onConnected?.();
        if (CONFIG.SIGNALING_BACKEND === "aws-apigateway") {
            clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(() => sendSignaling({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
        }
    };

    socket.onmessage = async (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch {
            console.warn("Ignoring malformed signaling response");
            return;
        }
        const myId = getMyId();
        if (data.type === "peer-list") {
            if (!Array.isArray(data.peers)) return;
            const snapshotPeerIds = new Set();
            data.peers.slice(0, CONFIG.MAX_PEERS).forEach((peer) => {
                if (peer?.peerId && peer.peerId !== myId) discoveredPeers.set(peer.peerId, peer);
                if (peer?.peerId && peer.peerId !== myId) snapshotPeerIds.add(peer.peerId);
            });
            // A delayed snapshot must not hide an already-open DataChannel.
            // Unconnected peers still reconcile to the authoritative snapshot;
            // peer-left remains the normal cleanup path for connected peers.
            discoveredPeers.forEach((_, peerId) => {
                const isConnected = peers.get(peerId)?.dataChannel?.readyState === "open";
                if (!snapshotPeerIds.has(peerId) && !isConnected) discoveredPeers.delete(peerId);
            });
            callbacks.onPeerListUpdate?.();
            callbacks.onDiscoveryComplete?.();
            return;
        }
        if (data.type === "peer-joined" && data.peerId !== myId) {
            discoveredPeers.set(data.peerId, { peerId: data.peerId, info: data.info });
            callbacks.onPeerListUpdate?.();
            return;
        }
        if (data.type === "peer-left") return cleanupPeer(data.peerId, "Peer disconnected", callbacks.onPeerListUpdate);
        if (data.type === "error") return console.warn("Signaling server notice:", data.message);

        try {
            if (data.type === "offer") {
                const pc = createPeerConnection(data.from, sendSignaling, callbacks.onPeerListUpdate);
                await pc.setRemoteDescription(data.offer);
                await flushQueuedIceCandidates(data.from);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sendSignaling({ type: "answer", target: data.from, answer: pc.localDescription });
            } else if (data.type === "answer") {
                const peer = peers.get(data.from);
                if (peer?.connection) {
                    await peer.connection.setRemoteDescription(data.answer);
                    await flushQueuedIceCandidates(data.from);
                }
            } else if (data.type === "candidate" && data.candidate) {
                await addOrQueueIceCandidate(data.from, data.candidate);
            }
        } catch (error) {
            console.error(`Failed to process ${data.type} signaling message:`, error);
        }
    };
    socket.onerror = () => console.warn("Signaling socket error; waiting to reconnect.");
    socket.onclose = () => {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        socket = null;
        callbacks.onDisconnected?.();
        scheduleReconnect();
    };
}

export function initSignaling(nextCallbacks = {}) {
    callbacks = nextCallbacks;
    intentionallyClosed = false;
    connect();
    return socket;
}

export function sendSignaling(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    // API Gateway uses `type` for route selection. Keep the browser-facing
    // offer/answer/candidate format intact while enclosing it in its one
    // serverless `signal` route.
    const outgoing = CONFIG.SIGNALING_BACKEND === "aws-apigateway" && ["offer", "answer", "candidate", "heartbeat"].includes(message.type)
        ? { type: "signal", target: message.target, signal: message.type === "heartbeat" ? { type: "heartbeat" } : message }
        : message;
    socket.send(JSON.stringify(outgoing));
    return true;
}

export function disconnectSignaling() {
    intentionallyClosed = true;
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    reconnectTimer = null;
    socket?.close();
    socket = null;
}
