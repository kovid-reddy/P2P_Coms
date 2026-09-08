const MOBILE_FALLBACK_MAX_MESSAGE_SIZE = 16 * 1024;
const ENCRYPTED_PAYLOAD_OVERHEAD = 16; // AES-GCM authentication tag
const TRANSPORT_SAFETY_MARGIN = 1024;
const MIN_USABLE_MESSAGE_SIZE = 2048;

export function getPeerMaxMessageSize(peer) {
    const value = peer?.connection?.sctp?.maxMessageSize;
    // A missing value (and 0, which is not consistently exposed by browsers)
    // must not inherit the desktop-only 256 KiB application default.
    return Number.isFinite(value) && value > 0 ? value : MOBILE_FALLBACK_MAX_MESSAGE_SIZE;
}

export function getEffectiveFileChunkSize(peer, configuredChunkSize) {
    const maxMessageSize = getPeerMaxMessageSize(peer);
    if (maxMessageSize < MIN_USABLE_MESSAGE_SIZE) {
        throw new Error("Negotiated RTCDataChannel maxMessageSize is too small for file transfer");
    }

    // File metadata is a separate, small string DataChannel message. The
    // encrypted binary message is plaintext + AES-GCM tag; reserve a further
    // margin for implementation/SCTP framing differences across mobile stacks.
    const payloadBudget = maxMessageSize - ENCRYPTED_PAYLOAD_OVERHEAD - TRANSPORT_SAFETY_MARGIN;
    return Math.min(configuredChunkSize, payloadBudget);
}

export function assertDataChannelMessageFits(payload, maxMessageSize) {
    const bytes = typeof payload === "string"
        ? new TextEncoder().encode(payload).byteLength
        : payload.byteLength;
    if (bytes > maxMessageSize) {
        throw new Error(`RTCDataChannel payload (${bytes} bytes) exceeds maxMessageSize (${maxMessageSize} bytes)`);
    }
}

export const FILE_CHUNK_SIZING = Object.freeze({
    MOBILE_FALLBACK_MAX_MESSAGE_SIZE,
    ENCRYPTED_PAYLOAD_OVERHEAD,
    TRANSPORT_SAFETY_MARGIN
});
