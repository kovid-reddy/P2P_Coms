import {
    createKeyExchangePayload,
    getMyId,
    getEcdhKeyPair,
    getEcdhPublicKeyString,
    hashString
} from "./identity.js";

import {
    importEcdsaPublicKeySpki,
    importEcdhPublicKeySpki,
    verifySignature,
    deriveEcdhSharedSecret,
    deriveSessionKey
} from "./crypto.js";
import { getOrCreatePeer } from "./state.js";

/**
 * Initiates E2EE Key Exchange with a peer over DataChannel
 */
export async function initiateKeyExchange(targetId) {
    const peer = getOrCreatePeer(targetId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== "open") {
        return;
    }
    try {
        const payload = await createKeyExchangePayload();
        peer.crypto.sentKeyExchange = true;
        peer.dataChannel.send(JSON.stringify(payload));
        console.log(`[E2EE] Sent key-exchange to peer: ${targetId}`);
    } catch (err) {
        console.error(`[E2EE] Error initiating key exchange with ${targetId}:`, err);
    }
}

/**
 * Handles incoming key-exchange message from a peer over DataChannel
 */
export async function handleKeyExchangeMessage(targetId, data) {
    const peer = getOrCreatePeer(targetId);

    // 1. Validation of payload fields
    if (!data.identityPublicKey || !data.ecdhPublicKey || !data.signature || !data.nonce) {
        console.error(`[SECURITY] Malformed key-exchange from ${targetId}`);
        return;
    }

    // 2. Verify identity public key matches expected peerId (targetId)
    const computedPeerId = await hashString(data.identityPublicKey);
    if (computedPeerId !== targetId) {
        console.error(`[SECURITY] Key-exchange identity mismatch: ${computedPeerId} !== ${targetId}`);
        return;
    }

    // 3. Verify ECDSA signature over (ecdhPublicKey + ":" + nonce) using identity public key
    try {
        const importedIdentityKey = await importEcdsaPublicKeySpki(data.identityPublicKey);
        const signedData = `${data.ecdhPublicKey}:${data.nonce}`;
        const isValidSignature = await verifySignature(importedIdentityKey, data.signature, signedData);

        if (!isValidSignature) {
            console.error(`[SECURITY] Invalid ECDH public key signature from ${targetId}`);
            return;
        }

        // 4. Import remote ECDH public key
        const importedRemoteEcdhKey = await importEcdhPublicKeySpki(data.ecdhPublicKey);

        // 5. Derive ECDH shared secret & HKDF AES-256-GCM session key
        const myId = getMyId();
        const localEcdhKey = getEcdhKeyPair().privateKey;
        const sharedSecret = await deriveEcdhSharedSecret(localEcdhKey, importedRemoteEcdhKey);

        // Deterministic salt based on sorted peer IDs
        const sortedPeerIds = [myId, targetId].sort();
        const saltString = await hashString(sortedPeerIds.join(":"));
        const saltBuffer = new TextEncoder().encode(saltString);
        const infoBuffer = new TextEncoder().encode("P2P-E2EE-AES-GCM-v1");

        const sessionKey = await deriveSessionKey(sharedSecret, saltBuffer, infoBuffer);

        // Deterministic session ID derived from values both peers know.
        // The nonce is intentionally NOT used because each peer generates
        // its own nonce independently.
        const myEcdhPublicKey = getEcdhPublicKeyString();

        const sortedEcdhKeys = [
            myEcdhPublicKey,
            data.ecdhPublicKey
        ].sort();

        const sessionId = "sess-" + (
            await hashString(
                `${sortedPeerIds.join(":")}:${sortedEcdhKeys.join(":")}`
            )
        );

        // Update peer.crypto state
        peer.crypto.sessionKey = sessionKey;
        peer.crypto.sessionId = sessionId;
        peer.crypto.remoteEcdhPublicKey = importedRemoteEcdhKey;
        peer.crypto.remoteIdentityPublicKey = importedIdentityKey;
        peer.crypto.handshakeComplete = true;
        const isNewSession = peer.crypto.sessionId !== sessionId;

        peer.crypto.sessionKey = sessionKey;
        peer.crypto.sessionId = sessionId;
        peer.crypto.remoteEcdhPublicKey = importedRemoteEcdhKey;
        peer.crypto.remoteIdentityPublicKey = importedIdentityKey;
        peer.crypto.handshakeComplete = true;

        if (isNewSession) {
            peer.crypto.localSeq = 0;
            peer.crypto.remoteSeq = 0;
        }

        console.log(`[E2EE] Session established with ${targetId} (Session ID: ${sessionId.slice(0, 16)}...)`);

        // 6. Respond with local key-exchange payload if not sent yet
        if (!peer.crypto.sentKeyExchange) {
            await initiateKeyExchange(targetId);
        }
    } catch (err) {
        console.error(`[E2EE] Failed processing key-exchange from ${targetId}:`, err);
    }
}
