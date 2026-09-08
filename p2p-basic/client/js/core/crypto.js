/**
 * Core Cryptographic Operations Module for Application-Level E2EE
 * Uses native Web Crypto API (window.crypto.subtle).
 */

// ─── Helpers: Base64 / ArrayBuffer conversion ───────────────────────────────

export function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

export function generateNonce(length = 12) {
    const nonce = new Uint8Array(length);
    crypto.getRandomValues(nonce);
    return nonce;
}

// ─── ECDH Key Generation & Import/Export ────────────────────────────────────

export async function generateEcdhKeyPair() {
    return await crypto.subtle.generateKey(
        {
            name: "ECDH",
            namedCurve: "P-256"
        },
        true,
        ["deriveKey", "deriveBits"]
    );
}

export async function exportPublicKeySpki(publicKey) {
    const exported = await crypto.subtle.exportKey("spki", publicKey);
    return arrayBufferToBase64(exported);
}

export async function importEcdhPublicKeySpki(spkiBase64) {
    const buffer = base64ToArrayBuffer(spkiBase64);
    return await crypto.subtle.importKey(
        "spki",
        buffer,
        {
            name: "ECDH",
            namedCurve: "P-256"
        },
        true,
        []
    );
}

export async function importEcdsaPublicKeySpki(spkiBase64) {
    const buffer = base64ToArrayBuffer(spkiBase64);
    return await crypto.subtle.importKey(
        "spki",
        buffer,
        {
            name: "ECDSA",
            namedCurve: "P-256"
        },
        true,
        ["verify"]
    );
}

// ─── ECDSA Signatures ────────────────────────────────────────────────────────

export async function signData(privateKey, dataBufferOrString) {
    const data = typeof dataBufferOrString === "string"
        ? new TextEncoder().encode(dataBufferOrString)
        : dataBufferOrString;

    const signature = await crypto.subtle.sign(
        {
            name: "ECDSA",
            hash: "SHA-256"
        },
        privateKey,
        data
    );

    return arrayBufferToBase64(signature);
}

export async function verifySignature(publicKey, signatureBase64, dataBufferOrString) {
    const data = typeof dataBufferOrString === "string"
        ? new TextEncoder().encode(dataBufferOrString)
        : dataBufferOrString;

    const signature = base64ToArrayBuffer(signatureBase64);

    return await crypto.subtle.verify(
        {
            name: "ECDSA",
            hash: "SHA-256"
        },
        publicKey,
        signature,
        data
    );
}

// ─── ECDH Shared Secret & HKDF Key Derivation ───────────────────────────────

export async function deriveEcdhSharedSecret(localPrivateEcdhKey, remotePublicEcdhKey) {
    return await crypto.subtle.deriveBits(
        {
            name: "ECDH",
            public: remotePublicEcdhKey
        },
        localPrivateEcdhKey,
        256 // 256 bits
    );
}

export async function deriveSessionKey(sharedSecretBits, saltBuffer, infoBuffer) {
    const hkdfKey = await crypto.subtle.importKey(
        "raw",
        sharedSecretBits,
        { name: "HKDF" },
        false,
        ["deriveKey"]
    );

    return await crypto.subtle.deriveKey(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: saltBuffer || new Uint8Array(32),
            info: infoBuffer || new TextEncoder().encode("P2P-E2EE-AES-GCM-v1")
        },
        hkdfKey,
        {
            name: "AES-GCM",
            length: 256
        },
        false,
        ["encrypt", "decrypt"]
    );
}

// ─── AES-GCM Encryption / Decryption ───────────────────────────────────────

export async function encryptPayload(aesKey, plaintextBufferOrString, ivBytes, aadBytes = null) {
    const plaintext = typeof plaintextBufferOrString === "string"
        ? new TextEncoder().encode(plaintextBufferOrString)
        : plaintextBufferOrString;

    const algorithm = {
        name: "AES-GCM",
        iv: ivBytes
    };

    if (aadBytes) {
        algorithm.additionalData = typeof aadBytes === "string"
            ? new TextEncoder().encode(aadBytes)
            : aadBytes;
    }

    return await crypto.subtle.encrypt(
        algorithm,
        aesKey,
        plaintext
    );
}

export async function decryptPayload(aesKey, ciphertextBuffer, ivBytes, aadBytes = null) {
    const algorithm = {
        name: "AES-GCM",
        iv: ivBytes
    };

    if (aadBytes) {
        algorithm.additionalData = typeof aadBytes === "string"
            ? new TextEncoder().encode(aadBytes)
            : aadBytes;
    }

    return await crypto.subtle.decrypt(
        algorithm,
        aesKey,
        ciphertextBuffer
    );
}
