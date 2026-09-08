import { getOrCreatePeer, getActivePeerId, markPeerConnected } from "../core/state.js";
import { handleIncomingChatMessage } from "../chat/receiveMessage.js";
import { handleFileMeta, handleChunkHeader, handleBinaryChunk, handleFileEnd, handleCancelTransfer } from "../transfer/receiveFile.js";
import { handleReadyMessage, handleRejectTransferMessage } from "../transfer/sendFile.js";
import { resetTransfer } from "../transfer/transferCleanup.js";
import { updateStatus } from "../ui/transferUI.js";
import { initiateKeyExchange, handleKeyExchangeMessage } from "../core/keyExchange.js";

export function setupDataChannel(targetId, dataChannel, onPeerListUpdate) {
    const peer = getOrCreatePeer(targetId);
    peer.dataChannel = dataChannel;

    dataChannel.binaryType = "arraybuffer";

    dataChannel.onopen = async () => {
        console.log("Connected to peer:", targetId);
        const { becameActive } = markPeerConnected(targetId);
        if (becameActive || getActivePeerId() === targetId) {
            updateStatus("Connected");
        }
        if (typeof onPeerListUpdate === "function") {
            onPeerListUpdate({ peerId: targetId, state: "connected", becameActive });
        }

        // Trigger E2EE Key Exchange over DataChannel
        await initiateKeyExchange(targetId);
    };

    dataChannel.onclose = async () => {
        console.log("Data channel closed with peer:", targetId);
        if (peer.transfer.state !== "idle") {
            await resetTransfer(targetId, "Data channel closed");
        }
        if (getActivePeerId() === targetId) {
            updateStatus("Disconnected");
        }
        if (typeof onPeerListUpdate === "function") {
            onPeerListUpdate();
        }
    };

    // Receive data onmessage event with PER-PEER sequential queue
    dataChannel.onmessage = (event) => {
        peer.chat.messageProcessingChain = peer.chat.messageProcessingChain
            .then(async () => {
                await dispatchDataChannelMessage(targetId, dataChannel, event.data, peer);
            })
            .catch((err) => {
                console.error(`Data channel message error for peer ${targetId}:`, err);
            });
    };
}

async function dispatchDataChannelMessage(targetId, dataChannel, eventData, peer) {
    /* ---------- STRING (JSON) MESSAGES ---------- */
    if (typeof eventData === "string") {
        let data;
        try {
            data = JSON.parse(eventData);
        } catch (parseErr) {
            console.error(`Malformed JSON on data channel from ${targetId}:`, parseErr);
            return;
        }

        if (!data || typeof data !== "object" || typeof data.type !== "string") {
            console.warn(`Invalid message structure from ${targetId}:`, data);
            return;
        }

        switch (data.type) {
            case "key-exchange":
                await handleKeyExchangeMessage(targetId, data);
                break;
            case "chat":
                await handleIncomingChatMessage(targetId, data, peer);
                break;
            case "file-meta":
                handleFileMeta(targetId, data);
                break;
            case "ready":
                handleReadyMessage(targetId, data.transferId);
                break;
            case "reject-transfer":
                await handleRejectTransferMessage(targetId, data.transferId, data.reason);
                break;
            case "file-chunk":
                handleChunkHeader(targetId, data);
                break;
            case "file-end":
                await handleFileEnd(targetId, data);
                break;
            case "cancel-transfer":
                await handleCancelTransfer(targetId, data);
                break;
            default:
                console.warn(`Unknown data channel message type from ${targetId}:`, data.type);
        }
        return;
    }

    /* ---------- BINARY CHUNK (ARRAYBUFFER) ---------- */
    if (eventData instanceof ArrayBuffer) {
        await handleBinaryChunk(targetId, eventData);
    }
}
