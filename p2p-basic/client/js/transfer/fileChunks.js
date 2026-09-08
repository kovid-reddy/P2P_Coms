import { CONFIG } from "../core/config.js";
import { getPeer, calculateTransferMetrics } from "../core/state.js";
import { createChunkHeaderMessage, createFileEndMessage } from "./transferProtocol.js";
import { createDiagnostics, recordChunkSent, recordBackpressureWait, finalizeDiagnostics } from "./transferDiagnostics.js";
import { generateNonce, encryptPayload, arrayBufferToBase64 } from "../core/crypto.js";
import { assertDataChannelMessageFits, getEffectiveFileChunkSize, getPeerMaxMessageSize } from "./chunkSizing.js";

export async function hashChunk(buffer) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

export async function sendFileChunks(targetId, onProgress, onComplete, onError) {
    const peer = getPeer(targetId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== "open") {
        if (onError) onError(new Error("Data channel not open"));
        return;
    }

    if (!peer.crypto || !peer.crypto.handshakeComplete || !peer.crypto.sessionKey) {
        if (onError) onError(new Error("E2EE session not established with peer"));
        return;
    }

    const dataChannel = peer.dataChannel;
    const transfer = peer.transfer;
    const file = transfer.file;
    const transferId = transfer.transferId;

    if (!file || transfer.state !== "transferring") return;

    // Initialize performance diagnostics for this transfer
    const diag = createDiagnostics();
    transfer.diagnostics = diag;

    dataChannel.bufferedAmountLowThreshold = CONFIG.BUFFERED_AMOUNT_LOW_THRESHOLD;

    const maxMessageSize = getPeerMaxMessageSize(peer);
    let chunkSize;
    try {
        chunkSize = getEffectiveFileChunkSize(peer, CONFIG.CHUNK_SIZE);
    } catch (error) {
        if (onError) onError(error);
        return;
    }
    transfer.effectiveChunkSize = chunkSize;
    let offset = 0;
    let chunkIndex = 0;

    // Handle 0-byte file immediately
    if (file.size === 0) {
        if (transfer.cancelled || transfer.transferId !== transferId) return;

        const emptyBuffer = new ArrayBuffer(0);
        const chunkHash = await hashChunk(emptyBuffer);
        const iv = generateNonce(12);
        const aad = `${transferId}:${chunkIndex}:${chunkHash}`;
        const encryptedEmptyBuffer = await encryptPayload(peer.crypto.sessionKey, emptyBuffer, iv, aad);

        const header = JSON.stringify({
            type: "file-chunk",
            transferId: transferId,
            chunkHash: chunkHash,
            chunkIndex: chunkIndex,
            iv: arrayBufferToBase64(iv),
            encrypted: true
        });
        assertDataChannelMessageFits(header, maxMessageSize);
        assertDataChannelMessageFits(encryptedEmptyBuffer, maxMessageSize);
        dataChannel.send(header);
        dataChannel.send(encryptedEmptyBuffer);
        const endMessage = JSON.stringify(createFileEndMessage(transferId));
        assertDataChannelMessageFits(endMessage, maxMessageSize);
        dataChannel.send(endMessage);

        transfer.state = "idle";
        transfer.offset = 0;
        if (onComplete) onComplete({ percent: 100, speed: 0, eta: null });
        return;
    }

    const reader = new FileReader();

    let readStartTime = 0;

    const readSlice = (o) => {
        if (transfer.cancelled || transfer.transferId !== transferId || dataChannel.readyState !== "open") {
            console.log(`Transmission halted for peer ${targetId}`);
            finalizeDiagnostics(diag, targetId, "send", peer.connection);
            return;
        }
        readStartTime = performance.now();
        const slice = file.slice(o, o + chunkSize);
        reader.readAsArrayBuffer(slice);
    };

    reader.onload = async (e) => {
        const readTimeMs = performance.now() - readStartTime;

        if (transfer.cancelled || transfer.transferId !== transferId || dataChannel.readyState !== "open") {
            console.log(`Stopped sending: transfer cancelled or channel closed for peer ${targetId}`);
            finalizeDiagnostics(diag, targetId, "send", peer.connection);
            return;
        }

        const buffer = e.target.result;

        const hashStart = performance.now();
        const chunkHash = await hashChunk(buffer);
        const hashTimeMs = performance.now() - hashStart;

        // Encrypt chunk buffer with AES-256-GCM + AAD
        const iv = generateNonce(12);
        const aad = `${transferId}:${chunkIndex}:${chunkHash}`;
        const encryptedChunkBuffer = await encryptPayload(peer.crypto.sessionKey, buffer, iv, aad);

        // Sample bufferedAmount before sending
        const bufferedAmount = dataChannel.bufferedAmount;

        try {
            const header = JSON.stringify({
                type: "file-chunk",
                transferId: transferId,
                chunkHash: chunkHash,
                chunkIndex: chunkIndex,
                iv: arrayBufferToBase64(iv),
                encrypted: true
            });
            // The encrypted binary payload—not only its plaintext—is bounded.
            // getEffectiveFileChunkSize reserved AES-GCM + SCTP safety space.
            assertDataChannelMessageFits(header, maxMessageSize);
            assertDataChannelMessageFits(encryptedChunkBuffer, maxMessageSize);
            dataChannel.send(header);
            dataChannel.send(encryptedChunkBuffer);
        } catch (sendErr) {
            console.error(`Error sending chunk to peer ${targetId}:`, sendErr);
            finalizeDiagnostics(diag, targetId, "send", peer.connection);
            if (onError) onError(sendErr);
            return;
        }

        // Record diagnostics for this chunk
        recordChunkSent(diag, buffer.byteLength, hashTimeMs, readTimeMs, bufferedAmount);

        chunkIndex++;
        offset += buffer.byteLength;
        transfer.offset = offset;

        const metrics = calculateTransferMetrics(transfer);
        if (onProgress) onProgress(metrics);

        if (offset < file.size) {
            if (dataChannel.bufferedAmount > CONFIG.BUFFERED_AMOUNT_LOW_THRESHOLD) {
                const bpWaitStart = performance.now();
                dataChannel.onbufferedamountlow = () => {
                    dataChannel.onbufferedamountlow = null;
                    recordBackpressureWait(diag, performance.now() - bpWaitStart);
                    if (!transfer.cancelled && transfer.transferId === transferId) {
                        readSlice(offset);
                    }
                };
            } else {
                readSlice(offset);
            }
        } else {
            try {
                const endMessage = JSON.stringify(createFileEndMessage(transferId));
                assertDataChannelMessageFits(endMessage, maxMessageSize);
                dataChannel.send(endMessage);
            } catch (err) {
                console.error(`Error sending file-end to peer ${targetId}:`, err);
            }
            transfer.state = "idle";
            finalizeDiagnostics(diag, targetId, "send", peer.connection);
            if (onComplete) onComplete(metrics);
        }
    };

    reader.onerror = (err) => {
        console.error(`FileReader error for peer ${targetId}:`, err);
        finalizeDiagnostics(diag, targetId, "send", peer.connection);
        if (onError) onError(err);
    };

    readSlice(0);
}
