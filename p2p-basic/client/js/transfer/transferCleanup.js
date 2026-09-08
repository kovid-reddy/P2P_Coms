import { getPeer, deletePeer, discoveredPeers, createInitialTransferState, getActivePeerId, setActivePeerId } from "../core/state.js";
import { refreshTransferView, updateStatus } from "../ui/transferUI.js";

export async function abortWritableStream(transfer, reason = "Aborted") {
    if (!transfer) return;

    const fileHandle = transfer.fileHandle;

    if (transfer.writableStream) {
        try {
            await transfer.writableStream.abort(reason);
        } catch (e) {
            console.warn("Writable stream abort error:", e);
        }
        transfer.writableStream = null;
    }

    // Attempt to remove the empty destination file left behind after abort.
    // Uses Chromium's non-standard FileSystemFileHandle.remove() — feature-detected.
    // Only safe because the writable stream was aborted (not closed), so the file
    // contains no valid user data (it's the 0-byte placeholder created by showSaveFilePicker).
    if (fileHandle) {
        if (typeof fileHandle.remove === "function") {
            try {
                await fileHandle.remove();
                console.log("Cleaned up incomplete destination file after aborted transfer");
            } catch (removeErr) {
                // Permission denied, file already gone, or API quirk — not critical
                console.warn("Could not remove incomplete destination file:", removeErr);
            }
        } else {
            console.warn(
                "FileSystemFileHandle.remove() not available — " +
                "empty destination file from aborted transfer may remain on disk"
            );
        }
        transfer.fileHandle = null;
    }
}

export async function resetTransfer(peerId, reason = "") {
    const peer = getPeer(peerId);
    if (!peer) return;

    const t = peer.transfer;
    t.cancelled = true;

    await abortWritableStream(t, reason || "Transfer stopped");

    if (peer.dataChannel) {
        peer.dataChannel.onbufferedamountlow = null;
    }

    peer.transfer = createInitialTransferState();

    if (reason && getActivePeerId() === peerId) {
        updateStatus(reason);
    }

    refreshTransferView(peerId);
}

export async function cleanupPeer(peerId, reason = "Peer disconnected", onPeerListUpdated = null) {
    discoveredPeers.delete(peerId);

    const peer = getPeer(peerId);
    if (peer) {
        if (peer.transfer && peer.transfer.state !== "idle") {
            await resetTransfer(peerId, reason);
        }
        if (peer.dataChannel) {
            try { peer.dataChannel.close(); } catch (e) {}
            peer.dataChannel = null;
        }
        if (peer.connection) {
            try { peer.connection.close(); } catch (e) {}
            peer.connection = null;
        }
        deletePeer(peerId);
    }

    if (getActivePeerId() === peerId) {
        setActivePeerId(null);
        updateStatus("Peer disconnected");
        refreshTransferView(null);
    }

    if (typeof onPeerListUpdated === "function") {
        onPeerListUpdated();
    }
}
