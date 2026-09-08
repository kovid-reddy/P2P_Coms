export function createFileMetaMessage(transferId, name, size) {
    return {
        type: "file-meta",
        transferId,
        name,
        size
    };
}

export function createReadyMessage(transferId) {
    return {
        type: "ready",
        transferId
    };
}

export function createRejectMessage(transferId, reason = "rejected") {
    return {
        type: "reject-transfer",
        transferId,
        reason
    };
}

export function createChunkHeaderMessage(transferId, hash) {
    return {
        type: "file-chunk",
        transferId,
        hash
    };
}

export function createFileEndMessage(transferId) {
    return {
        type: "file-end",
        transferId
    };
}

export function createCancelMessage(transferId, reason = "cancelled") {
    return {
        type: "cancel-transfer",
        transferId,
        reason
    };
}

export function isTransferIdValid(peerTransfer, incomingTransferId) {
    return Boolean(
        peerTransfer &&
        peerTransfer.transferId &&
        incomingTransferId &&
        peerTransfer.transferId === incomingTransferId
    );
}
