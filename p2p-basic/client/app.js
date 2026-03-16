const socket = new WebSocket("wss://kinetographic-nonspontaneously-charlyn.ngrok-free.dev");

const peers = new Map();

const MAX_PEERS = 4;
let keyPair;
let publicKeyString;
let peerId;

let receiverReady = false;
let fileToSend = null;

let expectedChunkHash = null;
let fileHandle = null;
let writableStream = null;

let incomingFileName = "";
let incomingFileSize = 0;
let receivedBytes = 0;

let pendingFileMeta = null;
let isCancelled = false;

let messageProcessingChain = Promise.resolve();


/* -----------------------------
   IDENTITY GENERATION
------------------------------*/

async function generateIdentity() {
    if (!window.isSecureContext) {
        alert("This page must be served over HTTPS or localhost for Web Crypto and WebRTC to work.\n\n" +
            "If testing on a local network, enable this Chrome flag:\n" +
            "chrome://flags/#unsafely-treat-insecure-origin-as-secure\n" +
            "and add: " + location.origin);
        return;
    }
    keyPair = await crypto.subtle.generateKey(
        {
            name: "ECDSA",
            namedCurve: "P-256"
        },
        true,
        ["sign", "verify"]
    );

    const exported = await crypto.subtle.exportKey(
        "spki",
        keyPair.publicKey
    );

    publicKeyString = btoa(
        String.fromCharCode(...new Uint8Array(exported))
    );

    peerId = await hashString(publicKeyString);

    console.log("Peer ID:", peerId);
}

//hash string function
async function hashString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}


/* -----------------------------
   WEBRTC CONFIG
------------------------------*/

const config = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject"
        }
    ]
};


/* -----------------------------
   SIGNALING
------------------------------*/

socket.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.offer) {
        await createPeer();
        await peerConnection.setRemoteDescription(data.offer);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.send(JSON.stringify({
            type: "answer",
            from: peerId,
            target: peerIdTarget,
            answer: answer
        }));
    }

    if (data.answer) {
        await peerConnection.setRemoteDescription(data.answer);
    }

    if (data.candidate) {
        await peerConnection.addIceCandidate(data.candidate);
    }

};


/* -----------------------------
   CREATE PEER
------------------------------*/

async function createPeer() {
    peerConnection = new RTCPeerConnection(config);

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.send(JSON.stringify({
                type: "candidate",
                from: peerId,
                target: peerIdTarget,
                candidate: event.candidate
            }));
        }
    };
    peerConnection.ondatachannel = (event) => {
        dataChannel = event.channel;
        setupDataChannel();
    };
}

//create peer connection
function createPeerConnection(peerId) {
    const pc = new RTCPeerConnection(config);
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.send(JSON.stringify({
                type: "candidate",
                from: peerId,
                target: peerIdTarget,
                candidate: event.candidate
            }));
        }
    };
    pc.ondatachannel = (event) => {
        const dc = event.channel;
        setupDataChannel(peerId, dc);
    };
    peers.set(peerId, { pc });
    return pc;
}

//connect to peer
async function connectToPeer(peerId) {
    const pc = new RTCPeerConnection(config);
    const dc = pc.createDataChannel("chat");
    peers.set(peerId, {
        connection: pc,
        dataChannel: dc
    });
    setupDataChannel(peerId, dc);
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.send(JSON.stringify({
                type: "candidate",
                from: peerIdSelf,
                target: peerIdTarget,
                candidate: event.candidate
            }));
        }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.send(JSON.stringify({
        type: "offer",
        from: peerIdSelf,
        target: peerIdTarget,
        offer: offer
    }));
}


/* -----------------------------
   START CONNECTION
------------------------------*/

async function startConnection() {
    await createPeer();
    dataChannel = peerConnection.createDataChannel("chat");
    setupDataChannel();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.send(JSON.stringify({
        type: "offer",
        from: peerId,
        target: peerIdTarget,
        offer: offer
    }));
}

/* -----------------------------
   DATA CHANNEL SETUP
------------------------------*/

function setupDataChannel() {
    peers.get(peerId).dc = dc;
    dc.open = () => {
        console.log("Connected to peer:", peerId);
    }
    dataChannel.binaryType = "arraybuffer";

    dataChannel.onclose = () => {
        document.getElementById("status").innerText = "Disconnected";
    };

    //receive data onmessage event
    dataChannel.onmessage = (event) => {
        handleIncomingMessage(peerId, event.data);
        messageProcessingChain = messageProcessingChain.then(async () => {
            try {

                /* ---------- PEER LIST ---------- */
                if (data.type === "peer-list") {
                    console.log("Discovered peers:", data.peers);
                    data.peers.slice(0, MAX_PEERS).forEach(p => {
                        if (!peers.has(p.peerId)) {
                            connectToPeer(p.peerId);
                        }
                    });
                }

                /* ---------- JSON ---------- */
                if (typeof event.data === "string") {
                    const data = JSON.parse(event.data);

                    /* -----------------------------
                       DATA CHANNEL MESSAGE
                    -----------------------------*/

                    if (data.type === "chat") {
                        const encoder = new TextEncoder();
                        const encodedMessage = encoder.encode(data.message);

                        const publicKeyBuffer = Uint8Array.from(
                            atob(data.publicKey),
                            c => c.charCodeAt(0)
                        );

                        const importedKey = await crypto.subtle.importKey(
                            "spki",
                            publicKeyBuffer,
                            {
                                name: "ECDSA",
                                namedCurve: "P-256"
                            },
                            true,
                            ["verify"]
                        );

                        const signatureBuffer = Uint8Array.from(
                            atob(data.signature),
                            c => c.charCodeAt(0)
                        );

                        const isValid = await crypto.subtle.verify(
                            {
                                name: "ECDSA",
                                hash: "SHA-256"
                            },
                            importedKey,
                            signatureBuffer,
                            encodedMessage
                        );

                        if (isValid) {
                            document.getElementById("chat").value +=
                                "Peer: " + data.message + "\n";
                        } else {
                            document.getElementById("chat").value +=
                                "⚠ Tampered message\n";
                        }
                    }

                    /* -----------------------------
                       FILE TRANSFER
                    -----------------------------*/

                    if (data.type === "file-meta") {
                        pendingFileMeta = data;
                        document.getElementById("incomingFileBox").style.display = "block";
                        document.getElementById("incomingFileName").innerText = data.name;
                        return;
                    }
                    if (data.type === "ready") {
                        receiverReady = true;
                        sendFileChunks();
                        return;
                    }
                    if (data.type === "file-chunk") {
                        expectedChunkHash = data.hash;
                        return;
                    }
                    if (data.type === "file-end") {
                        if (writableStream) {
                            await writableStream.close();
                            writableStream = null;
                        }
                        console.log("File saved");
                        return;
                    }
                }

                /* ---------- BINARY CHUNK ---------- */

                if (event.data instanceof ArrayBuffer) {
                    if (!writableStream) {
                        console.log("Stream not ready");
                        return;
                    }

                    //verify hash
                    const hashBuffer = await crypto.subtle.digest(
                        "SHA-256",
                        event.data
                    );
                    const receivedHash = Array.from(new Uint8Array(hashBuffer))
                        .map(b => b.toString(16).padStart(2, "0"))
                        .join("");

                    if (receivedHash !== expectedChunkHash) {
                        console.error("Chunk corrupted");
                        await writableStream.abort();
                        writableStream = null;
                        return;
                    }

                    //update progress
                    receivedBytes += event.data.byteLength;
                    let percent = 0;
                    if (incomingFileSize > 0) {
                        percent = Math.round(
                            (receivedBytes / incomingFileSize) * 100
                        );
                    }
                    document.getElementById("transferProgress").value = percent;
                    document.getElementById("transferPercent").innerText = percent;

                    //write chunk to file
                    await writableStream.write(event.data);
                }
            }
            catch (err) {
                console.error("Data channel error:", err);
            }
        });
    };
}


/* -----------------------------
   ACCEPT FILE
------------------------------*/

async function acceptFile() {
    if (!pendingFileMeta) return;
    try {
        if (!("showSaveFilePicker" in window)) {
            alert("Browser not supported");
            return;
        }

        fileHandle = await window.showSaveFilePicker({
            suggestedName: pendingFileMeta.name
        });

        writableStream = await fileHandle.createWritable();

        incomingFileName = pendingFileMeta.name;
        incomingFileSize = pendingFileMeta.size;

        receivedBytes = 0;
        pendingFileMeta = null;

        document.getElementById("incomingFileBox").style.display = "none";
        document.getElementById("status").innerText = "Receiving file...";
        dataChannel.send(JSON.stringify({ type: "ready" }));

    }
    catch (e) {
        console.error("File picker error:", e);
    }

}

/* -----------------------------
    SEND MESSAGE
------------------------------*/

async function sendMessage() {

    if (!keyPair) {
        alert("Keys not ready yet. Please wait a moment.");
        return;
    }

    const message = document.getElementById("message").value;
    if (!message || !dataChannel) return;

    const encoder = new TextEncoder();
    const data = encoder.encode(message);

    const signature = await crypto.subtle.sign(
        {
            name: "ECDSA",
            hash: "SHA-256"
        },
        keyPair.privateKey,
        data
    );

    const signatureBase64 = btoa(
        String.fromCharCode(...new Uint8Array(signature))
    );

    dataChannel.send(JSON.stringify({
        type: "chat",
        message: message,
        signature: signatureBase64,
        publicKey: publicKeyString
    }));
}

/* -----------------------------
   SEND FILE
------------------------------*/

function sendFile() {
    const file = document.getElementById("fileInput").files[0];
    if (!file) return;

    fileToSend = file;
    receiverReady = false;

    dataChannel.send(JSON.stringify({
        type: "file-meta",
        name: file.name,
        size: file.size
    }));
}


/* -----------------------------
   SEND FILE CHUNKS
------------------------------*/

async function sendFileChunks() {
    const file = fileToSend;
    if (!file) return;

    const chunkSize = 256 * 1024; // 256KB
    let offset = 0;
    const reader = new FileReader();
    const readSlice = (o) => {
        const slice = file.slice(o, o + chunkSize);
        reader.readAsArrayBuffer(slice);
    };
    reader.onload = async (e) => {
        const buffer = e.target.result;
        const hashBuffer = await crypto.subtle.digest(
            "SHA-256",
            buffer
        );
        const chunkHash = Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, "0"))
            .join("");

        dataChannel.send(JSON.stringify({
            type: "file-chunk",
            hash: chunkHash
        }));
        dataChannel.send(buffer);
        offset += buffer.byteLength;
        let percent = 0;
        if (file.size > 0) {
            percent = Math.floor((offset / file.size) * 100);
        }

        document.getElementById("transferProgress").value = percent;
        document.getElementById("transferPercent").innerText = percent;

        if (offset < file.size) {
            if (dataChannel.bufferedAmount > 4 * 1024 * 1024) {
                dataChannel.onbufferedamountlow = () => {
                    readSlice(offset);
                };
            }
            else {
                readSlice(offset);
            }
        }
        else {
            dataChannel.send(JSON.stringify({
                type: "file-end"
            }));
            document.getElementById("status").innerText = "File sent";
        }
    };
    dataChannel.bufferedAmountLowThreshold = 4 * 1024 * 1024; // 4MB
    readSlice(0);
}

window.onload = async () => {
    await generateIdentity();
    socket.onopen = () => {
        console.log("Connected to bootstrap");
        socket.send(JSON.stringify({
            type: "register",
            peerId: peerId,
            info: "webrtc"
        }));
        socket.send(JSON.stringify({
            type: "discover"
        }));
    };
};