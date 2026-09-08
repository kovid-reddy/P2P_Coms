import { getActivePeerId, getPeer, formatBytes } from "../core/state.js";

export function updateStatus(text) {
    const statusEl = document.getElementById("status");
    if (statusEl) {
        statusEl.innerText = text;
    }
}

function formatSpeed(bytesPerSec) {
    if (bytesPerSec <= 0) return "—";
    return formatBytes(bytesPerSec) + "/s";
}

function formatEta(seconds) {
    if (seconds === null || seconds === undefined || seconds < 0) return "—";
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
}

export function showIncomingPrompt(fileName, fileSize, peerId) {
    const incomingBox = document.getElementById("incomingFileBox");
    const nameEl = document.getElementById("incomingFileName");
    if (incomingBox) incomingBox.style.display = "flex";
    if (nameEl) {
        const sizeStr = fileSize > 0 ? ` (${formatBytes(fileSize)})` : "";
        nameEl.innerText = `${fileName}${sizeStr}`;
    }
    updateStatus(`Incoming file from ${peerId.slice(0, 8)}...`);
}

export function hideIncomingPrompt() {
    const incomingBox = document.getElementById("incomingFileBox");
    if (incomingBox) incomingBox.style.display = "none";
}

export function showTransferProgress(fileName, direction, initialPercent = 0) {
    const progressContainer = document.getElementById("progressContainer");
    const cancelBtn = document.getElementById("cancelBtn");
    const progressEl = document.getElementById("transferProgress");
    const percentEl = document.getElementById("transferPercent");
    const fileTitle = document.getElementById("transferFileTitle");
    const dirBadge = document.getElementById("transferDirectionBadge");
    const speedEl = document.getElementById("transferSpeedMetric");
    const etaEl = document.getElementById("transferEtaMetric");

    if (progressContainer) progressContainer.style.display = "flex";

    // Only show cancel button for sender
    if (cancelBtn) cancelBtn.style.display = direction === "send" ? "inline-flex" : "none";

    if (progressEl) progressEl.value = initialPercent;
    if (percentEl) percentEl.innerText = initialPercent.toString();
    if (fileTitle) fileTitle.innerText = fileName || "Transferring...";

    if (dirBadge) {
        dirBadge.className = `card-badge ${direction === "send" ? "badge-active" : "badge-incoming"}`;
        dirBadge.innerText = direction === "send" ? "Sending" : "Receiving";
    }

    if (speedEl) speedEl.innerText = "—";
    if (etaEl) etaEl.innerText = "ETA: —";
}

export function hideTransferProgress() {
    const progressContainer = document.getElementById("progressContainer");
    const cancelBtn = document.getElementById("cancelBtn");
    if (progressContainer) progressContainer.style.display = "none";
    if (cancelBtn) cancelBtn.style.display = "none";
}

export function updateTransferProgress(percent, metrics = null, customStatus = "") {
    const progressEl = document.getElementById("transferProgress");
    const percentEl = document.getElementById("transferPercent");
    const speedEl = document.getElementById("transferSpeedMetric");
    const etaEl = document.getElementById("transferEtaMetric");

    if (progressEl) progressEl.value = percent;
    if (percentEl) percentEl.innerText = percent.toString();

    if (metrics) {
        if (speedEl) speedEl.innerText = formatSpeed(metrics.speed);
        if (etaEl) etaEl.innerText = `ETA: ${formatEta(metrics.eta)}`;
    }

    if (customStatus) {
        updateStatus(customStatus);
    }
}

export function refreshTransferView(peerId) {
    const activePeerId = getActivePeerId();

    // If the update is not for the active peer, only hide if active peer has no transfer
    if (!peerId || peerId !== activePeerId) {
        const activePeer = activePeerId ? getPeer(activePeerId) : null;
        if (!activePeer || activePeer.transfer.state === "idle") {
            hideIncomingPrompt();
            hideTransferProgress();
        }
        return;
    }

    const peer = getPeer(peerId);
    if (!peer || peer.transfer.state === "idle") {
        hideIncomingPrompt();
        hideTransferProgress();
        return;
    }

    const t = peer.transfer;

    if (t.state === "prompting") {
        hideTransferProgress();
        showIncomingPrompt(t.fileName, t.fileSize, peerId);
        return;
    }

    if (t.state === "offering") {
        hideIncomingPrompt();
        showTransferProgress(t.fileName, "send", 0);
        return;
    }

    if (t.state === "transferring") {
        hideIncomingPrompt();
        const currentBytes = t.direction === "send" ? t.offset : t.receivedBytes;
        const percent = t.fileSize > 0
            ? Math.min(100, Math.floor((currentBytes / t.fileSize) * 100))
            : 100;

        showTransferProgress(t.fileName, t.direction, percent);
        updateTransferProgress(percent, {
            speed: t.speed,
            eta: t.eta
        });
    }
}
