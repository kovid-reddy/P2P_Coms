import { getActivePeerId, getPeer } from "../core/state.js";

function formatTimestamp(ts) {
    if (!ts) return "";
    const date = new Date(ts);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}

export function appendChatMessage(sender, text, timestamp = Date.now(), authenticated = false) {
    const list = document.getElementById("chatMessages");
    const emptyNotice = document.getElementById("emptyChatNotice");
    const container = document.getElementById("messagesContainer");

    if (emptyNotice) {
        emptyNotice.style.display = "none";
    }

    if (!list) return;

    const isOutgoing = sender === "me" || sender === "Me";
    const bubble = document.createElement("div");
    bubble.className = `message-bubble ${isOutgoing ? "outgoing" : "incoming"}`;

    const textEl = document.createElement("div");
    textEl.className = "message-text";
    textEl.innerText = text;
    bubble.appendChild(textEl);

    const metaRow = document.createElement("div");
    metaRow.className = "message-meta-row";

    if (!isOutgoing && authenticated) {
        const authBadge = document.createElement("span");
        authBadge.className = "auth-badge";
        authBadge.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Authenticated`;
        metaRow.appendChild(authBadge);
    }

    const timeEl = document.createElement("span");
    timeEl.className = "message-time";
    timeEl.innerText = formatTimestamp(timestamp);
    metaRow.appendChild(timeEl);

    bubble.appendChild(metaRow);
    list.appendChild(bubble);

    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

export function appendSystemNotice(text) {
    const list = document.getElementById("chatMessages");
    const emptyNotice = document.getElementById("emptyChatNotice");
    const container = document.getElementById("messagesContainer");

    if (emptyNotice) {
        emptyNotice.style.display = "none";
    }

    if (!list) return;

    const notice = document.createElement("div");
    notice.className = "system-notice";
    notice.innerText = text;
    list.appendChild(notice);

    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

export function renderConversation(peerId) {
    const list = document.getElementById("chatMessages");
    const emptyNotice = document.getElementById("emptyChatNotice");
    const container = document.getElementById("messagesContainer");

    if (!list) return;
    list.innerHTML = "";

    if (!peerId) {
        if (emptyNotice) {
            emptyNotice.style.display = "flex";
            const h3 = emptyNotice.querySelector("h3");
            const p = emptyNotice.querySelector("p");
            if (h3) h3.innerText = "Select a peer to start chatting";
            if (p) p.innerText = "Direct WebRTC DataChannel connection with end-to-end ECDSA cryptographic signatures.";
        }
        return;
    }

    const peer = getPeer(peerId);
    const messages = peer?.chat?.messages || [];

    if (messages.length === 0) {
        if (emptyNotice) {
            emptyNotice.style.display = "flex";
            const h3 = emptyNotice.querySelector("h3");
            const p = emptyNotice.querySelector("p");
            const isConnected = peer?.dataChannel?.readyState === "open";
            if (h3) h3.innerText = isConnected ? "Conversation started" : "Connecting to peer...";
            if (p) p.innerText = isConnected ? "Say hello! Messages and file transfers are direct and authenticated." : "Waiting for WebRTC handshake to complete...";
        }
    } else {
        if (emptyNotice) {
            emptyNotice.style.display = "none";
        }

        messages.forEach((msg) => {
            if (msg.sender === "system") {
                appendSystemNotice(msg.text);
            } else {
                appendChatMessage(msg.sender, msg.text, msg.timestamp, msg.authenticated);
            }
        });
    }

    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

export function updateComposerState(peerId) {
    const messageInput = document.getElementById("message");
    const sendBtn = document.getElementById("sendMessageBtn");
    const attachBtn = document.getElementById("attachFileBtn");

    if (!messageInput || !sendBtn) return;

    if (!peerId) {
        messageInput.disabled = true;
        sendBtn.disabled = true;
        if (attachBtn) attachBtn.disabled = true;
        messageInput.placeholder = "Select a peer to start chatting...";
        return;
    }

    const peer = getPeer(peerId);
    const isChannelOpen = peer && peer.dataChannel && peer.dataChannel.readyState === "open";

    if (isChannelOpen) {
        messageInput.disabled = false;
        sendBtn.disabled = false;
        if (attachBtn) attachBtn.disabled = false;
        messageInput.placeholder = "Type a message... (Enter to send, Shift+Enter for newline)";
    } else {
        messageInput.disabled = true;
        sendBtn.disabled = true;
        if (attachBtn) attachBtn.disabled = true;
        messageInput.placeholder = "Connecting to peer...";
    }
}

export function getChatMessageInput() {
    const input = document.getElementById("message");
    return input ? input.value.trim() : "";
}

export function clearChatMessageInput() {
    const input = document.getElementById("message");
    if (input) {
        input.value = "";
    }
}

