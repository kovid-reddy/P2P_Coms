import { discoveredPeers, peers, getActivePeerId } from "../core/state.js";
import { getMyId } from "../core/identity.js";

export function renderPeerList(onPeerClick) {
    const container = document.getElementById("peerList");
    const peerCountBadge = document.getElementById("peerCountBadge");
    const noPeersPrompt = document.getElementById("noPeersPrompt");

    if (!container) return;
    container.innerHTML = "";

    const myId = getMyId();
    const activePeerId = getActivePeerId();

    let count = 0;

    discoveredPeers.forEach((info, peerId) => {
        if (peerId === myId) return;
        count++;

        const btn = document.createElement("button");
        btn.id = "peer-btn-" + peerId;
        btn.className = `peer-item-btn ${peerId === activePeerId ? "active-peer" : ""}`;
        btn.setAttribute("aria-label", `Peer ${peerId.slice(0, 8)}`);

        const peer = peers.get(peerId);
        let dotClass = "dot-offline";
        let statusText = "Online";

        if (peer && peer.dataChannel && peer.dataChannel.readyState === "open") {
            dotClass = "dot-online";
            statusText = "Connected";
        } else if (peer?.networkState === "failed") {
            statusText = "Connection failed";
        } else if (peer?.networkState === "disconnected") {
            statusText = "Disconnected";
        } else if (
            peer &&
            peer.connection &&
            (peer.connection.connectionState === "connecting" ||
                peer.connection.iceConnectionState === "checking" ||
                peer.connection.iceConnectionState === "connecting")
        ) {
            dotClass = "dot-connecting";
            statusText = "Connecting...";
        }

        const unreadCount = (peer && peer.chat && peer.chat.unreadCount) || 0;
        const unreadHtml = unreadCount > 0 && peerId !== activePeerId
            ? `<span class="unread-badge">${unreadCount}</span>`
            : "";

        const shortId = `${peerId.slice(0, 6)}...${peerId.slice(-4)}`;
        const avatarInitial = peerId.slice(0, 2).toUpperCase();

        btn.innerHTML = `
            <div class="peer-avatar">${avatarInitial}</div>
            <div class="peer-details">
                <div class="peer-id-text" title="${peerId}">${shortId}</div>
                <div class="peer-substatus">
                    <span class="status-dot ${dotClass}"></span>
                    <span>${statusText}</span>
                </div>
            </div>
            ${unreadHtml}
        `;

        btn.onclick = () => {
            if (typeof onPeerClick === "function") {
                onPeerClick(peerId);
            }
        };

        container.appendChild(btn);
    });

    if (peerCountBadge) {
        peerCountBadge.innerText = count.toString();
    }

    if (noPeersPrompt) {
        noPeersPrompt.style.display = count === 0 ? "flex" : "none";
    }
}
