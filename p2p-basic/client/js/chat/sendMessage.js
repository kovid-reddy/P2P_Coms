import { getKeyPair, getPublicKeyString } from "../core/identity.js";
import { getPeer } from "../core/state.js";
import { appendChatMessage, clearChatMessageInput } from "../ui/chatUI.js";
import { signData, generateNonce, encryptPayload, arrayBufferToBase64 } from "../core/crypto.js";

export async function sendChatMessage(targetId, messageText) {
    const keyPair = getKeyPair();
    const publicKeyString = getPublicKeyString();

    if (!keyPair || !publicKeyString) {
        alert("Keys not ready yet. Please wait a moment.");
        return;
    }

    const message = (messageText || "").trim();
    if (!message) return;

    if (!targetId) {
        alert("Please select an active peer to chat with.");
        return;
    }

    const peer = getPeer(targetId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== "open") {
        alert("Data channel is not open with the selected peer.");
        return;
    }

    if (!peer.crypto || !peer.crypto.handshakeComplete || !peer.crypto.sessionKey) {
        alert("Establishing E2EE session with peer. Please wait a moment.");
        return;
    }

    // 1. Sign plaintext message with identity private key
    const signatureBase64 = await signData(keyPair.privateKey, message);

    // 2. Increment local sequence counter for replay protection
    peer.crypto.localSeq = (peer.crypto.localSeq || 0) + 1;
    const seq = peer.crypto.localSeq;
    const sessionId = peer.crypto.sessionId;

    // 3. Prepare inner plaintext JSON payload
    const innerPayload = JSON.stringify({
        text: message,
        signature: signatureBase64,
        timestamp: Date.now()
    });

    // 4. Generate fresh 12-byte IV & AAD
    const iv = generateNonce(12);
    const aad = `${sessionId}:${seq}:chat`;

    // 5. AES-256-GCM Encryption
    const ciphertextBuffer = await encryptPayload(peer.crypto.sessionKey, innerPayload, iv, aad);

    // 6. Send encrypted envelope over DataChannel
    peer.dataChannel.send(JSON.stringify({
        type: "chat",
        encrypted: true,
        sessionId: sessionId,
        seq: seq,
        iv: arrayBufferToBase64(iv),
        ciphertext: arrayBufferToBase64(ciphertextBuffer),
        publicKey: publicKeyString
    }));

    peer.chat.messages.push({
        sender: "me",
        text: message,
        timestamp: Date.now(),
        authenticated: false
    });

    appendChatMessage("Me", message, Date.now(), false);
    clearChatMessageInput();
}

