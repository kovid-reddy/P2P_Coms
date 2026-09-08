import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { getEffectiveFileChunkSize, getPeerMaxMessageSize, FILE_CHUNK_SIZING } from "./chunkSizing.js";
import { encryptPayload, generateNonce } from "../core/crypto.js";

globalThis.crypto ??= webcrypto;

test("effective file payload fits a 16 KiB negotiated SCTP limit including encryption margin", async () => {
    const maxMessageSize = 16 * 1024;
    const peer = { connection: { sctp: { maxMessageSize } } };
    const chunkSize = getEffectiveFileChunkSize(peer, 256 * 1024);
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const encrypted = await encryptPayload(key, new Uint8Array(chunkSize).buffer, generateNonce(12), "aad");

    assert.equal(chunkSize, maxMessageSize - FILE_CHUNK_SIZING.TRANSPORT_SAFETY_MARGIN - FILE_CHUNK_SIZING.ENCRYPTED_PAYLOAD_OVERHEAD);
    assert.equal(encrypted.byteLength, chunkSize + FILE_CHUNK_SIZING.ENCRYPTED_PAYLOAD_OVERHEAD);
    assert.ok(encrypted.byteLength <= maxMessageSize);
});

test("missing SCTP maxMessageSize uses the conservative mobile fallback", () => {
    const chunkSize = getEffectiveFileChunkSize({ connection: {} }, 256 * 1024);
    assert.equal(getPeerMaxMessageSize({ connection: {} }), FILE_CHUNK_SIZING.MOBILE_FALLBACK_MAX_MESSAGE_SIZE);
    assert.equal(chunkSize, FILE_CHUNK_SIZING.MOBILE_FALLBACK_MAX_MESSAGE_SIZE - FILE_CHUNK_SIZING.TRANSPORT_SAFETY_MARGIN - FILE_CHUNK_SIZING.ENCRYPTED_PAYLOAD_OVERHEAD);
});

test("variable-size chunks reconstruct the original bytes and hash exactly", () => {
    const original = Uint8Array.from({ length: 50_003 }, (_, index) => index % 251);
    const chunkSize = getEffectiveFileChunkSize({ connection: { sctp: { maxMessageSize: 16 * 1024 } } }, 256 * 1024);
    const chunks = [];
    for (let offset = 0; offset < original.byteLength; offset += chunkSize) chunks.push(original.slice(offset, offset + chunkSize));
    const reconstructed = new Uint8Array(original.byteLength);
    let offset = 0;
    for (const chunk of chunks) { reconstructed.set(chunk, offset); offset += chunk.byteLength; }

    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    assert.deepEqual(reconstructed, original);
    assert.equal(digest(reconstructed), digest(original));
});
