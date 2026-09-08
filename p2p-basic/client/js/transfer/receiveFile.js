import { getPeer, peers, getActivePeerId, calculateTransferMetrics } from "../core/state.js";
import { resetTransfer } from "./transferCleanup.js";
import { hashChunk } from "./fileChunks.js";
import { createReadyMessage, createRejectMessage, createCancelMessage, isTransferIdValid } from "./transferProtocol.js";
import { updateTransferProgress, updateStatus, refreshTransferView } from "../ui/transferUI.js";
import { createDiagnostics, recordChunkReceived, finalizeDiagnostics } from "./transferDiagnostics.js";
import { base64ToArrayBuffer, decryptPayload } from "../core/crypto.js";

export function handleFileMeta(targetId, data) {
    const peer = getPeer(targetId);
    if (!peer) return;

    if (!data.name || typeof data.size !== "number" || data.size < 0 || !data.transferId) {
        console.warn(`Malformed file-meta from ${targetId}:`, data);
        return;
    }

    // Support ONE active file transfer per peer
    if (peer.transfer.state !== "idle") {
        console.warn(`Peer ${targetId} sent file-meta while transfer is ${peer.transfer.state}. Rejecting as busy.`);
        if (peer.dataChannel && peer.dataChannel.readyState === "open") {
            peer.dataChannel.send(JSON.stringify(createRejectMessage(data.transferId, "busy")));
        }
        return;
    }

    peer.transfer.state = "prompting";
    peer.transfer.direction = "receive";
    peer.transfer.transferId = data.transferId;
    peer.transfer.fileName = data.name;
    peer.transfer.fileSize = data.size;
    peer.transfer.receivedBytes = 0;
    peer.transfer.expectedChunkHash = null;
    peer.transfer.expectedChunkIndex = null;
    peer.transfer.expectedChunkIv = null;
    peer.transfer.cancelled = false;
    peer.transfer.startTime = null;
    peer.transfer.speed = 0;
    peer.transfer.eta = null;

    refreshTransferView(targetId);
}

export async function acceptIncomingFile(targetId = null) {
    let targetPeer = targetId ? getPeer(targetId) : null;
    if (!targetPeer || targetPeer.transfer.state !== "prompting") {
        const activeId = getActivePeerId();
        targetPeer = activeId ? getPeer(activeId) : null;
    }
    if (!targetPeer || targetPeer.transfer.state !== "prompting") {
        targetPeer = Array.from(peers.values()).find(p => p.transfer.state === "prompting");
    }

    if (!targetPeer || targetPeer.transfer.state !== "prompting") return;

    const peerId = targetPeer.peerId;
    const dataChannel = targetPeer.dataChannel;

    if (!dataChannel || dataChannel.readyState !== "open") {
        alert("Peer connection is closed.");
        await resetTransfer(peerId, "Connection closed");
        return;
    }

    if (!("showSaveFilePicker" in window)) {
        alert("Your browser does not support the File System Access API.");
        return;
    }

    try {
        const fileHandle = await window.showSaveFilePicker({
            suggestedName: targetPeer.transfer.fileName
        });

        const writableStream = await fileHandle.createWritable();

        targetPeer.transfer.fileHandle = fileHandle;
        targetPeer.transfer.writableStream = writableStream;
        targetPeer.transfer.state = "transferring";
        targetPeer.transfer.receivedBytes = 0;
        targetPeer.transfer.cancelled = false;

        // Initialize performance diagnostics for this incoming transfer
        targetPeer.transfer.diagnostics = createDiagnostics();

        refreshTransferView(peerId);

        dataChannel.send(JSON.stringify(
            createReadyMessage(targetPeer.transfer.transferId)
        ));
    } catch (e) {
        if (e.name === "AbortError") {
            console.log("User cancelled file save dialog");
        } else {
            console.error("File picker error:", e);
        }

        if (dataChannel && dataChannel.readyState === "open") {
            try {
                dataChannel.send(JSON.stringify(
                    createRejectMessage(targetPeer.transfer.transferId, "cancelled-picker")
                ));
            } catch (err) {}
        }
        await resetTransfer(peerId, "File save cancelled");
    }
}

export async function rejectIncomingFile(targetId = null) {
    let targetPeer = targetId ? getPeer(targetId) : null;
    if (!targetPeer || targetPeer.transfer.state !== "prompting") {
        const activeId = getActivePeerId();
        targetPeer = activeId ? getPeer(activeId) : null;
    }
    if (!targetPeer || targetPeer.transfer.state !== "prompting") {
        targetPeer = Array.from(peers.values()).find(p => p.transfer.state === "prompting");
    }

    if (!targetPeer || targetPeer.transfer.state !== "prompting") return;

    const peerId = targetPeer.peerId;
    if (targetPeer.dataChannel && targetPeer.dataChannel.readyState === "open") {
        try {
            targetPeer.dataChannel.send(JSON.stringify(
                createRejectMessage(targetPeer.transfer.transferId, "rejected-by-user")
            ));
        } catch (e) {
            console.error("Error sending reject message:", e);
        }
    }

    await resetTransfer(peerId, "Transfer rejected");
}

export function handleChunkHeader(targetId, data) {
    const peer = getPeer(targetId);
    if (!peer) return;

    if (!isTransferIdValid(peer.transfer, data.transferId)) {
        console.warn(`Ignoring chunk header with mismatch transferId from ${targetId}`);
        return;
    }

    peer.transfer.expectedChunkHash = data.chunkHash || data.hash;
    peer.transfer.expectedChunkIndex = data.chunkIndex;
    peer.transfer.expectedChunkIv = data.iv;
}

export async function handleBinaryChunk(targetId, arrayBuffer) {
    const peer = getPeer(targetId);
    if (!peer) return;

    const t = peer.transfer;
    const dataChannel = peer.dataChannel;

    if (t.state !== "transferring" || !t.writableStream) {
        console.warn(`Discarding unexpected binary chunk from ${targetId} in state ${t.state}`);
        return;
    }

    if (!peer.crypto || !peer.crypto.handshakeComplete || !peer.crypto.sessionKey) {
        console.error(`[SECURITY] Cannot decrypt file chunk: E2EE session not ready with ${targetId}`);
        await resetTransfer(targetId, "E2EE session error");
        return;
    }

    if (!t.expectedChunkHash || !t.expectedChunkIv || typeof t.expectedChunkIndex !== "number") {
        console.error(`Received binary chunk from ${targetId} missing chunk header metadata. Aborting.`);
        if (dataChannel && dataChannel.readyState === "open" && t.transferId) {
            try {
                dataChannel.send(JSON.stringify(createCancelMessage(t.transferId, "missing-header")));
            } catch (e) {}
        }
        await resetTransfer(targetId, "Transfer aborted: unexpected chunk");
        return;
    }

    // Step 1: AES-256-GCM Decryption of binary chunk
    let plaintextBuffer;
    try {
        const ivBytes = new Uint8Array(base64ToArrayBuffer(t.expectedChunkIv));
        const aad = `${t.transferId}:${t.expectedChunkIndex}:${t.expectedChunkHash}`;
        plaintextBuffer = await decryptPayload(peer.crypto.sessionKey, arrayBuffer, ivBytes, aad);
    } catch (decryptErr) {
        console.error(`[SECURITY] AES-GCM File chunk decryption failure from ${targetId}:`, decryptErr);
        if (dataChannel && dataChannel.readyState === "open" && t.transferId) {
            try {
                dataChannel.send(JSON.stringify(createCancelMessage(t.transferId, "decryption-failed")));
            } catch (e) {}
        }
        finalizeDiagnostics(t.diagnostics, targetId, "receive", peer.connection);
        await resetTransfer(targetId, "Decryption error (tampered chunk or invalid key)");
        return;
    }

    // Step 2: Verify SHA-256 plaintext chunk hash
    const hashStart = performance.now();
    const receivedHash = await hashChunk(plaintextBuffer);
    const hashTimeMs = performance.now() - hashStart;

    if (receivedHash !== t.expectedChunkHash) {
        console.error(`[INTEGRITY] Corrupted decrypted chunk from ${targetId}! Expected: ${t.expectedChunkHash}, Got: ${receivedHash}`);
        if (dataChannel && dataChannel.readyState === "open" && t.transferId) {
            try {
                dataChannel.send(JSON.stringify(createCancelMessage(t.transferId, "hash-mismatch")));
            } catch (e) {}
        }
        finalizeDiagnostics(t.diagnostics, targetId, "receive", peer.connection);
        await resetTransfer(targetId, "Corrupted chunk detected! Transfer aborted.");
        return;
    }

    t.expectedChunkHash = null;
    t.expectedChunkIv = null;
    t.expectedChunkIndex = null;
    t.receivedBytes += plaintextBuffer.byteLength;

    const metrics = calculateTransferMetrics(t);
    if (getActivePeerId() === targetId) {
        updateTransferProgress(metrics.percent, metrics);
    }

    // Direct-to-disk write of plaintext chunk
    try {
        const writeStart = performance.now();
        await t.writableStream.write(plaintextBuffer);
        const writeTimeMs = performance.now() - writeStart;

        // Record diagnostics for this received chunk
        recordChunkReceived(t.diagnostics, plaintextBuffer.byteLength, hashTimeMs, writeTimeMs);
    } catch (writeErr) {
        console.error(`Error writing chunk to disk for ${targetId}:`, writeErr);
        if (dataChannel && dataChannel.readyState === "open" && t.transferId) {
            try {
                dataChannel.send(JSON.stringify(createCancelMessage(t.transferId, "write-error")));
            } catch (e) {}
        }
        finalizeDiagnostics(t.diagnostics, targetId, "receive", peer.connection);
        await resetTransfer(targetId, "Disk write error during transfer");
    }
}

export async function handleFileEnd(targetId, data) {
    const peer = getPeer(targetId);
    if (!peer) return;

    if (!isTransferIdValid(peer.transfer, data.transferId)) {
        console.warn(`Ignoring file-end with mismatch transferId from ${targetId}`);
        return;
    }

    if (peer.transfer.writableStream) {
        try {
            await peer.transfer.writableStream.close();
        } catch (closeErr) {
            console.error(`Error closing writable stream for ${targetId}:`, closeErr);
        }
        // Finalize diagnostics before clearing transfer state
        finalizeDiagnostics(peer.transfer.diagnostics, targetId, "receive", peer.connection);
        peer.transfer.writableStream = null;
        peer.transfer.fileHandle = null;
        console.log(`File from ${targetId} saved successfully`);
        if (getActivePeerId() === targetId) {
            updateStatus("File saved successfully");
        }
    }

    peer.transfer.state = "idle";
    refreshTransferView(targetId);
}

export async function handleCancelTransfer(targetId, data) {
    const peer = getPeer(targetId);
    if (!peer) return;

    if (!isTransferIdValid(peer.transfer, data.transferId)) {
        console.warn(`Ignoring cancel-transfer with mismatch transferId from ${targetId}`);
        return;
    }

    await resetTransfer(targetId, "Transfer cancelled by peer");
}
