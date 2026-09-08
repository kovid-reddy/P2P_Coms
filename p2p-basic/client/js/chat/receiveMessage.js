import { hashString } from "../core/identity.js";
import { appendChatMessage, appendSystemNotice } from "../ui/chatUI.js";
import { base64ToArrayBuffer, decryptPayload, importEcdsaPublicKeySpki, verifySignature } from "../core/crypto.js";

export async function handleIncomingChatMessage(targetId, data, peer) {
    if (!data.encrypted || !data.ciphertext || !data.iv || !data.seq || !data.sessionId) {
        console.warn(`[SECURITY] Unencrypted or malformed chat message rejected from ${targetId}`);
        appendSystemNotice(`⚠ Rejected unencrypted message from ${targetId.slice(0, 8)}`);
        return;
    }

    if (!data.publicKey || typeof data.publicKey !== "string") {
        console.error(`[SECURITY] Chat message from ${targetId} missing identity public key`);
        appendSystemNotice(`⚠ Unauthenticated message rejected from ${targetId.slice(0, 8)}...`);
        return;
    }

    // Step 1: Verify SHA-256(publicKey) === expected sender peer ID (targetId)
    const computedPeerId = await hashString(data.publicKey);
    if (computedPeerId !== targetId) {
        console.error(`[SECURITY] Identity mismatch: ${computedPeerId} !== ${targetId}`);
        appendSystemNotice(`⚠ Identity mismatch: message from ${targetId.slice(0, 8)}... rejected!`);
        return;
    }

    // Step 2: Validate active E2EE session and session ID
    if (!peer.crypto || !peer.crypto.handshakeComplete || !peer.crypto.sessionKey) {
        console.error(`[SECURITY] E2EE session not ready with ${targetId}`);
        appendSystemNotice(`⚠ E2EE session not established with ${targetId.slice(0, 8)}`);
        return;
    }

    if (data.sessionId !== peer.crypto.sessionId) {
        console.error(`[SECURITY] Stale or invalid session ID from ${targetId} (${data.sessionId} !== ${peer.crypto.sessionId})`);
        appendSystemNotice(`⚠ Stale session message rejected from ${targetId.slice(0, 8)}`);
        return;
    }

    // Step 3: Replay protection (verify sequence number)
    if (typeof data.seq !== "number" || data.seq <= (peer.crypto.remoteSeq || 0)) {
        console.error(`[SECURITY] Replay attack detected from ${targetId}! Seq ${data.seq} <= last ${peer.crypto.remoteSeq}`);
        appendSystemNotice(`⚠ Replayed message rejected from ${targetId.slice(0, 8)}`);
        return;
    }

    // Step 4: AES-256-GCM Decryption with AAD
    let innerPayloadText;
    try {
        const ivBytes = new Uint8Array(base64ToArrayBuffer(data.iv));
        const ciphertextBuffer = base64ToArrayBuffer(data.ciphertext);
        const aad = `${peer.crypto.sessionId}:${data.seq}:chat`;

        const decryptedBuffer = await decryptPayload(peer.crypto.sessionKey, ciphertextBuffer, ivBytes, aad);
        innerPayloadText = new TextDecoder().decode(decryptedBuffer);
    } catch (decryptErr) {
        console.error(`[SECURITY] AES-GCM Decryption failure from ${targetId}:`, decryptErr);
        appendSystemNotice(`⚠ Decryption failed / tampered payload from ${targetId.slice(0, 8)}`);
        return;
    }

    // Step 5: Parse inner JSON payload and verify ECDSA signature
    try {
        const innerPayload = JSON.parse(innerPayloadText);
        if (!innerPayload || typeof innerPayload.text !== "string" || !innerPayload.signature) {
            console.error(`[SECURITY] Invalid decrypted payload format from ${targetId}`);
            appendSystemNotice(`⚠ Malformed decrypted payload from ${targetId.slice(0, 8)}`);
            return;
        }

        const importedKey = await importEcdsaPublicKeySpki(data.publicKey);
        const isValidSignature = await verifySignature(importedKey, innerPayload.signature, innerPayload.text);

        if (isValidSignature) {
            // Update sequence counter for replay window
            peer.crypto.remoteSeq = data.seq;

            peer.chat.messages.push({
                sender: targetId,
                text: innerPayload.text,
                timestamp: innerPayload.timestamp || Date.now(),
                authenticated: true
            });

            peer.chat.unreadCount = (peer.chat.unreadCount || 0) + 1;
            appendChatMessage(`Peer (${targetId.slice(0, 8)})`, innerPayload.text, innerPayload.timestamp || Date.now(), true);
        } else {
            console.error(`[SECURITY] ECDSA Signature verification failed for decrypted message from ${targetId}`);
            appendSystemNotice(`⚠ Signature failure on decrypted message from ${targetId.slice(0, 8)}`);
        }
    } catch (e) {
        console.error("Payload parsing or signature verification error:", e);
        appendSystemNotice(`⚠ Message processing error from ${targetId.slice(0, 8)}`);
    }
}

