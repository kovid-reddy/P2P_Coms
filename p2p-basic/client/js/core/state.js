export const peers = new Map();
export const discoveredPeers = new Map();

let activePeerId = null;

export function getActivePeerId() {
    return activePeerId;
}

export function setActivePeerId(id) {
    activePeerId = id;
}

/**
 * A successfully opened data channel is authoritative evidence that a peer is
 * reachable, even when its signaling-presence notification arrived late. Keep
 * discoveredPeers as the UI's known-peer/presence index, but add this verified
 * peer once by ID so a subsequent discovery event simply updates the same map
 * entry rather than creating a second peer representation.
 */
export function markPeerConnected(peerId, info = "webrtc") {
    const peer = getOrCreatePeer(peerId);
    peer.networkState = "connected";

    if (!discoveredPeers.has(peerId)) {
        discoveredPeers.set(peerId, { peerId, info });
    }

    // Incoming connections have no user click to select a conversation. Do
    // not interrupt an existing multi-peer conversation, however.
    const becameActive = activePeerId === null;
    if (becameActive) {
        activePeerId = peerId;
    }

    return { peer, becameActive };
}

export function createInitialCryptoState() {
    return {
        handshakeComplete: false,
        sessionKey: null,
        sessionId: null,
        remoteEcdhPublicKey: null,
        remoteIdentityPublicKey: null,
        localSeq: 0,
        remoteSeq: 0
    };
}

export function createInitialTransferState() {
    return {
        state: "idle",       // "idle" | "offering" | "prompting" | "transferring"
        direction: null,     // "send" | "receive" | null
        transferId: null,
        effectiveChunkSize: null,

        file: null,          // File instance (sender)
        fileName: "",
        fileSize: 0,

        offset: 0,           // Bytes sent (sender)
        receivedBytes: 0,    // Bytes written (receiver)

        expectedChunkHash: null,
        fileHandle: null,
        writableStream: null,

        receiverReady: false,
        cancelled: false,

        // Hardened metrics
        startTime: null,
        lastTime: null,
        lastBytes: 0,
        speed: 0,            // bytes / sec
        eta: null,           // seconds remaining

        // Performance diagnostics (populated by transferDiagnostics.js)
        diagnostics: null
    };
}

export function getOrCreatePeer(peerId) {
    let peer = peers.get(peerId);
    if (!peer) {
        peer = {
            peerId: peerId,
            connection: null,
            dataChannel: null,
            networkState: "discovered",
            pendingIceCandidates: [],
            crypto: createInitialCryptoState(),
            chat: {
                messages: [],
                unreadCount: 0,
                messageProcessingChain: Promise.resolve()
            },
            transfer: createInitialTransferState()
        };
        peers.set(peerId, peer);
    }
    return peer;
}

export function resetPeerCrypto(peerId) {
    const peer = getPeer(peerId);
    if (peer) {
        peer.crypto = createInitialCryptoState();
    }
}

export function getPeer(peerId) {
    return peers.get(peerId) || null;
}

export function deletePeer(peerId) {
    resetPeerCrypto(peerId);
    peers.delete(peerId);
}

export function generateTransferId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return "t-" + Date.now() + "-" + Math.random().toString(36).slice(2, 11);
}

export function formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function calculateTransferMetrics(transfer) {
    const now = Date.now();
    const currentBytes = transfer.direction === "send" ? transfer.offset : transfer.receivedBytes;
    const totalBytes = transfer.fileSize;

    if (!transfer.startTime) {
        transfer.startTime = now;
        transfer.lastTime = now;
        transfer.lastBytes = currentBytes;
        transfer.speed = 0;
        transfer.eta = null;
        return { speed: 0, eta: null, percent: totalBytes > 0 ? 0 : 100 };
    }

    const elapsedTotal = (now - transfer.startTime) / 1000;
    const elapsedSample = (now - transfer.lastTime) / 1000;

    if (elapsedSample >= 0.3 || currentBytes >= totalBytes) {
        const bytesDiff = currentBytes - transfer.lastBytes;
        const currentSpeed = elapsedSample > 0 ? bytesDiff / elapsedSample : 0;
        transfer.speed = transfer.speed > 0 ? (transfer.speed * 0.7 + currentSpeed * 0.3) : currentSpeed;
        transfer.lastTime = now;
        transfer.lastBytes = currentBytes;

        const remainingBytes = Math.max(0, totalBytes - currentBytes);
        if (transfer.speed > 0) {
            transfer.eta = Math.ceil(remainingBytes / transfer.speed);
        } else if (elapsedTotal > 0 && currentBytes > 0) {
            const avgSpeed = currentBytes / elapsedTotal;
            transfer.eta = Math.ceil(remainingBytes / avgSpeed);
        } else {
            transfer.eta = null;
        }
    }

    const percent = totalBytes > 0 ? Math.min(100, Math.floor((currentBytes / totalBytes) * 100)) : 100;
    return {
        speed: Math.round(transfer.speed),
        eta: transfer.eta,
        percent: percent,
        currentBytes: currentBytes,
        totalBytes: totalBytes
    };
}
