import { CONFIG } from "../core/config.js";
import { getOrCreatePeer } from "../core/state.js";
import { getMyId } from "../core/identity.js";
import { setupDataChannel } from "./dataChannel.js";

export async function logSelectedCandidatePair(pc, targetId) {
    try {
        const stats = await pc.getStats();
        let selectedPairId = null;
        stats.forEach((report) => {
            if (report.type === "transport" && report.selectedCandidatePairId) {
                selectedPairId = report.selectedCandidatePairId;
            }
        });

        stats.forEach((report) => {
            if (report.type === "candidate-pair" && (report.nominated || report.selected || report.id === selectedPairId)) {
                if (report.state === "succeeded" || report.selected || report.nominated) {
                    const localCandidate = stats.get(report.localCandidateId);
                    const remoteCandidate = stats.get(report.remoteCandidateId);
                    console.log(
                        `[WebRTC] Active candidate pair for ${targetId}: ` +
                        `Local (${localCandidate?.candidateType || "unknown"}, ${localCandidate?.protocol || "unknown"}) <-> ` +
                        `Remote (${remoteCandidate?.candidateType || "unknown"}, ${remoteCandidate?.protocol || "unknown"})`
                    );
                }
            }
        });
    } catch (e) {
        console.warn("[WebRTC] Could not inspect stats for candidate pairs:", e);
    }
}

export function createPeerConnection(targetId, sendSignaling, onPeerListUpdate) {
    const pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            const type = event.candidate.type || "unknown";
            console.log(`[ICE] Local candidate gathered for peer ${targetId} [type: ${type}]`);
            if (typeof sendSignaling === "function") {
                sendSignaling({
                    type: "candidate",
                    from: getMyId(),
                    target: targetId,
                    candidate: event.candidate
                });
            }
        } else {
            console.log(`[ICE] Candidate gathering complete for peer ${targetId}`);
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[ICE] Connection state with ${targetId}: ${pc.iceConnectionState}`);
        const peer = getOrCreatePeer(targetId);
        if (pc.iceConnectionState === "failed") peer.networkState = "failed";
        if (pc.iceConnectionState === "disconnected") peer.networkState = "disconnected";
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") peer.networkState = "connected";
        onPeerListUpdate?.();
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
            logSelectedCandidatePair(pc, targetId);
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] Peer connection state with ${targetId}: ${pc.connectionState}`);
        const peer = getOrCreatePeer(targetId);
        peer.networkState = pc.connectionState;
        onPeerListUpdate?.();
    };

    pc.ondatachannel = (event) => {
        setupDataChannel(targetId, event.channel, onPeerListUpdate);
    };

    const peer = getOrCreatePeer(targetId);
    peer.connection = pc;
    peer.networkState = "connecting";
    return pc;
}

export async function addOrQueueIceCandidate(targetId, candidate) {
    const peer = getOrCreatePeer(targetId);
    if (!peer.connection || !peer.connection.remoteDescription) {
        peer.pendingIceCandidates.push(candidate);
        return;
    }
    await peer.connection.addIceCandidate(candidate);
}

export async function flushQueuedIceCandidates(targetId) {
    const peer = getOrCreatePeer(targetId);
    if (!peer.connection?.remoteDescription) return;
    const pending = peer.pendingIceCandidates.splice(0);
    for (const candidate of pending) await peer.connection.addIceCandidate(candidate);
}

export async function connectToPeer(targetId, sendSignaling, onPeerListUpdate) {
    const pc = createPeerConnection(targetId, sendSignaling, onPeerListUpdate);
    const dc = pc.createDataChannel("chat");
    setupDataChannel(targetId, dc, onPeerListUpdate);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (typeof sendSignaling === "function") {
        sendSignaling({
            type: "offer",
            from: getMyId(),
            target: targetId,
        offer: pc.localDescription
        });
    }
}
