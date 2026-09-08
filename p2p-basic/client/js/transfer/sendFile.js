import { getPeer, generateTransferId, getActivePeerId } from "../core/state.js";
import { resetTransfer } from "./transferCleanup.js";
import { sendFileChunks } from "./fileChunks.js";
import { createFileMetaMessage, createCancelMessage, isTransferIdValid } from "./transferProtocol.js";
import { updateTransferProgress, updateStatus, refreshTransferView } from "../ui/transferUI.js";
import { assertDataChannelMessageFits, getPeerMaxMessageSize } from "./chunkSizing.js";

export function initiateSendFile(targetId, file) {
    if (!file) {
        alert("Please select a file to send.");
        return;
    }

    if (!targetId) {
        alert("Please select an active peer to send the file to.");
        return;
    }

    const peer = getPeer(targetId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== "open") {
        alert("Data channel is not open with the active peer.");
        return;
    }

    // Support ONE active file transfer per peer
    if (peer.transfer.state !== "idle") {
        alert("A file transfer is already active with this peer. Please wait or cancel it first.");
        return;
    }

    const transferId = generateTransferId();

    peer.transfer.state = "offering";
    peer.transfer.direction = "send";
    peer.transfer.transferId = transferId;
    peer.transfer.file = file;
    peer.transfer.fileName = file.name;
    peer.transfer.fileSize = file.size;
    peer.transfer.offset = 0;
    peer.transfer.receiverReady = false;
    peer.transfer.cancelled = false;
    peer.transfer.startTime = null;
    peer.transfer.speed = 0;
    peer.transfer.eta = null;

    refreshTransferView(targetId);

    try {
        const metadata = JSON.stringify(createFileMetaMessage(transferId, file.name, file.size));
        assertDataChannelMessageFits(metadata, getPeerMaxMessageSize(peer));
        peer.dataChannel.send(metadata);
    } catch (error) {
        resetTransfer(targetId, `Error starting file transfer: ${error.message}`);
    }
}

export function handleReadyMessage(targetId, transferId) {
    const peer = getPeer(targetId);
    if (!peer) return;

    if (!isTransferIdValid(peer.transfer, transferId)) {
        console.warn(`Ignoring ready message with invalid transferId ${transferId} from ${targetId}`);
        return;
    }

    if (peer.transfer.state !== "offering") {
        console.warn(`Ignoring ready message in state ${peer.transfer.state} from ${targetId}`);
        return;
    }

    peer.transfer.receiverReady = true;
    peer.transfer.state = "transferring";
    refreshTransferView(targetId);

    sendFileChunks(
        targetId,
        (metrics) => {
            if (getActivePeerId() === targetId) {
                updateTransferProgress(metrics.percent, metrics);
            }
        },
        () => {
            if (getActivePeerId() === targetId) {
                updateStatus("File sent successfully");
            }
            refreshTransferView(targetId);
        },
        async (err) => {
            await resetTransfer(targetId, `Error sending file: ${err.message}`);
        }
    );
}

export async function handleRejectTransferMessage(targetId, transferId, reason) {
    const peer = getPeer(targetId);
    if (!peer) return;

    if (!isTransferIdValid(peer.transfer, transferId)) {
        console.warn(`Ignoring reject-transfer with mismatch transferId from ${targetId}`);
        return;
    }

    await resetTransfer(targetId, `Transfer rejected by peer (${reason || "declined"})`);
}

export async function cancelActiveTransfer(targetId) {
    const peer = getPeer(targetId);
    if (!peer || peer.transfer.state === "idle") return;

    const transferId = peer.transfer.transferId;
    peer.transfer.cancelled = true;

    if (peer.dataChannel) {
        peer.dataChannel.onbufferedamountlow = null;
        if (peer.dataChannel.readyState === "open" && transferId) {
            try {
                peer.dataChannel.send(JSON.stringify(createCancelMessage(transferId, "user-cancelled")));
            } catch (e) {
                console.warn("Failed sending cancel message:", e);
            }
        }
    }

    await resetTransfer(targetId, "Transfer cancelled");
}
