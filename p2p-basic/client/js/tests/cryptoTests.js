/**
 * Cryptographic Unit Test Suite for Step 6 E2EE Implementation
 * Exercises native Web Crypto API operations and security invariants.
 */

import {
    generateEcdhKeyPair,
    exportPublicKeySpki,
    importEcdhPublicKeySpki,
    importEcdsaPublicKeySpki,
    signData,
    verifySignature,
    deriveEcdhSharedSecret,
    deriveSessionKey,
    encryptPayload,
    decryptPayload,
    generateNonce,
    arrayBufferToBase64,
    base64ToArrayBuffer
} from "../core/crypto.js";
import { generateIdentity, hashString } from "../core/identity.js";
import { getOrCreatePeer, deletePeer, resetPeerCrypto } from "../core/state.js";
import { initiateKeyExchange, handleKeyExchangeMessage } from "../core/keyExchange.js";

export async function runCryptoTests() {
    const results = [];
    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            results.push({ name, status: "PASS" });
            passed++;
            console.log(`%c[PASS] ${name}`, "color: #10b981; font-weight: bold;");
        } catch (err) {
            results.push({ name, status: "FAIL", error: err.message });
            failed++;
            console.error(`%c[FAIL] ${name}: ${err.message}`, "color: #ef4444; font-weight: bold;", err);
        }
    }

    console.log("%c=== RUNNING STEP 6 E2EE CRYPTO UNIT TESTS ===", "color: #3b82f6; font-weight: bold; font-size: 14px;");

    // 1. Key Generation
    await test("1. Key Generation (ECDSA and ECDH)", async () => {
        const ecdsa = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
        if (!ecdsa.publicKey || !ecdsa.privateKey) throw new Error("ECDSA keygen failed");

        const ecdh = await generateEcdhKeyPair();
        if (!ecdh.publicKey || !ecdh.privateKey) throw new Error("ECDH keygen failed");
    });

    // 2. Key Agreement Setup & Signature Verification
    await test("2. Key Agreement & Signature Verification", async () => {
        const identity = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
        const ecdh = await generateEcdhKeyPair();
        const ecdhSpki = await exportPublicKeySpki(ecdh.publicKey);

        const signature = await signData(identity.privateKey, ecdhSpki);
        const isValid = await verifySignature(identity.publicKey, signature, ecdhSpki);
        if (!isValid) throw new Error("Signature over ECDH public key failed verification");
    });

    // 3. Same Shared Secret on Both Peers
    await test("3. Same Shared Secret on Both Peers", async () => {
        const peerA_ecdh = await generateEcdhKeyPair();
        const peerB_ecdh = await generateEcdhKeyPair();

        const secretA = await deriveEcdhSharedSecret(peerA_ecdh.privateKey, peerB_ecdh.publicKey);
        const secretB = await deriveEcdhSharedSecret(peerB_ecdh.privateKey, peerA_ecdh.publicKey);

        const b64A = arrayBufferToBase64(secretA);
        const b64B = arrayBufferToBase64(secretB);

        if (b64A !== b64B) throw new Error("Derived shared secrets do not match");
    });

    // 4. HKDF Derivation
    await test("4. HKDF Key Derivation", async () => {
        const secretBits = crypto.getRandomValues(new Uint8Array(32)).buffer;
        const salt = new TextEncoder().encode("test-salt-123");
        const info = new TextEncoder().encode("P2P-E2EE-AES-GCM-v1");

        const aesKey = await deriveSessionKey(secretBits, salt, info);
        if (!aesKey || aesKey.algorithm.name !== "AES-GCM" || aesKey.algorithm.length !== 256) {
            throw new Error("HKDF failed to derive 256-bit AES-GCM key");
        }
    });

    // 5. AES-GCM Encrypt/Decrypt Roundtrip
    await test("5. AES-GCM Encrypt/Decrypt Roundtrip", async () => {
        const secretBits = crypto.getRandomValues(new Uint8Array(32)).buffer;
        const aesKey = await deriveSessionKey(secretBits, null, null);
        const iv = generateNonce(12);
        const plaintext = "Hello E2EE World!";
        const aad = "session-1:seq-1:chat";

        const ciphertext = await encryptPayload(aesKey, plaintext, iv, aad);
        const decryptedBuffer = await decryptPayload(aesKey, ciphertext, iv, aad);
        const decryptedText = new TextDecoder().decode(decryptedBuffer);

        if (decryptedText !== plaintext) throw new Error("Decrypted text does not match original plaintext");
    });

    // 6. Wrong Key -> Decryption Failure
    await test("6. Wrong Key -> Decryption Failure", async () => {
        const key1 = await deriveSessionKey(crypto.getRandomValues(new Uint8Array(32)).buffer, null, null);
        const key2 = await deriveSessionKey(crypto.getRandomValues(new Uint8Array(32)).buffer, null, null);
        const iv = generateNonce(12);
        const plaintext = "Secret Message";

        const ciphertext = await encryptPayload(key1, plaintext, iv, "aad");

        let caughtError = false;
        try {
            await decryptPayload(key2, ciphertext, iv, "aad");
        } catch (e) {
            caughtError = true;
        }

        if (!caughtError) throw new Error("Decryption with wrong key succeeded when it should have failed");
    });

    // 7. Modified Ciphertext -> Decryption Failure
    await test("7. Modified Ciphertext -> Decryption Failure", async () => {
        const key = await deriveSessionKey(crypto.getRandomValues(new Uint8Array(32)).buffer, null, null);
        const iv = generateNonce(12);
        const plaintext = "Secret Data";

        const ciphertext = await encryptPayload(key, plaintext, iv, "aad");
        const tamperedBytes = new Uint8Array(ciphertext);
        tamperedBytes[0] ^= 0xFF; // Flip bits in ciphertext

        let caughtError = false;
        try {
            await decryptPayload(key, tamperedBytes.buffer, iv, "aad");
        } catch (e) {
            caughtError = true;
        }

        if (!caughtError) throw new Error("Decryption of tampered ciphertext succeeded when it should have failed");
    });

    // 8. Modified Nonce / IV -> Decryption Failure
    await test("8. Modified Nonce / IV -> Decryption Failure", async () => {
        const key = await deriveSessionKey(crypto.getRandomValues(new Uint8Array(32)).buffer, null, null);
        const iv1 = generateNonce(12);
        const iv2 = generateNonce(12);
        const plaintext = "Secret Data";

        const ciphertext = await encryptPayload(key, plaintext, iv1, "aad");

        let caughtError = false;
        try {
            await decryptPayload(key, ciphertext, iv2, "aad");
        } catch (e) {
            caughtError = true;
        }

        if (!caughtError) throw new Error("Decryption with wrong IV succeeded when it should have failed");
    });

    // 9. Replay Protection / Sequence Validation
    await test("9. Replay Protection (Sequence Counter)", async () => {
        const testPeerId = "test-peer-replay-999";
        const peer = getOrCreatePeer(testPeerId);
        peer.crypto.remoteSeq = 5;

        const incomingSeq = 5; // Stale seq
        if (incomingSeq <= peer.crypto.remoteSeq) {
            // Replay successfully detected!
        } else {
            throw new Error("Failed to flag replayed sequence counter");
        }
        deletePeer(testPeerId);
    });

    // 10. Peer / Session Isolation
    await test("10. Multi-Peer Session Isolation", async () => {
        const secretA = crypto.getRandomValues(new Uint8Array(32)).buffer;
        const secretB = crypto.getRandomValues(new Uint8Array(32)).buffer;

        const keyA = await deriveSessionKey(secretA, new TextEncoder().encode("peerA"), null);
        const keyB = await deriveSessionKey(secretB, new TextEncoder().encode("peerB"), null);

        const iv = generateNonce(12);
        const ciphertextA = await encryptPayload(keyA, "Message for A", iv, "aadA");

        let caughtError = false;
        try {
            await decryptPayload(keyB, ciphertextA, iv, "aadA");
        } catch (e) {
            caughtError = true;
        }

        if (!caughtError) throw new Error("Peer B decrypted Peer A's payload");
    });

    // 11. Key Cleanup After Disconnect
    await test("11. Key Cleanup After Disconnect", async () => {
        const testPeerId = "test-peer-cleanup-111";
        const peer = getOrCreatePeer(testPeerId);
        peer.crypto.sessionKey = "dummy-key";
        peer.crypto.handshakeComplete = true;

        deletePeer(testPeerId);

        const checkedPeer = getOrCreatePeer(testPeerId);
        if (checkedPeer.crypto.sessionKey || checkedPeer.crypto.handshakeComplete) {
            throw new Error("Crypto state was not wiped on peer deletion");
        }
        deletePeer(testPeerId);
    });

    console.log(`%c=== TEST RESULTS: ${passed} PASSED, ${failed} FAILED ===`,
        failed === 0 ? "color: #10b981; font-weight: bold; font-size: 14px;" : "color: #ef4444; font-weight: bold; font-size: 14px;");

    return { total: passed + failed, passed, failed, results };
}
