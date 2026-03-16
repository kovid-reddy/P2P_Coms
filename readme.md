# P2P Secure File Transfer & Chat

A secure, decentralized peer-to-peer chat and file-sharing web application. It uses a WebSocket server for initial discovery and WebRTC Data Channels for direct, peer-to-peer data transfers. Identity generation, secure message signing, and file chunk verification are handled on the client side using the Web Crypto API.

## Features

- **Peer-to-Peer Connections**: Uses WebRTC for direct communication without server relaying.
- **Secure Messaging**: Messages are signed using ECDSA (P-256 Curve). The recipient verifies the signature to detect tampered messages.
- **Reliable File Transfer**: Files are divided into 256KB chunks, each hashed with SHA-256. Received chunks are locally verified for integrity before being written directly to disk via the File System Access API.
- **Transfer Progress Indicator**: Built-in progress bars visually track upload and download progress for large files.
- **Decentralized Identity**: ECDSA key pairs and Peer IDs are auto-generated on load.

## Architecture Structure

- **`p2p-basic/client/`**: Contains the vanilla HTML, CSS, and JavaScript. The frontend interacts directly with WebRTC APIs and the Web Crypto API.
- **`p2p-basic/server/`**: A lightweight Node.js WebSocket signaling server. It acts purely as a bootstrap node to route WebRTC signaling (offers, answers, ICE candidates) between peers, and holds no active role in the data transfer itself.

## Setup & Running

**Prerequisites:** Node.js installed.

1. **Install Dependencies:**
   In the root directory, install the required packages:
   ```bash
   npm install
   ```

2. **Start the Signaling Server:**
   Navigate to the server directory and run the server file:
   ```bash
   cd p2p-basic/server
   node server.js
   ```
   The signaling server will run on `ws://localhost:3000`.

3. **Open the Client:**
   Open `p2p-basic/client/index.html` in your web browser. 

   *Note: Because Web Crypto API and WebRTC data channels require secure contexts, the page must be served over HTTPS or `localhost`.*
   *To test on a local network via an IP without HTTPS, you can enable Chrome's unsafely treat insecure origin flag:*
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure`