# P2P Secure File Transfer & Chat

A secure, decentralized peer-to-peer chat and file-sharing web application built with vanilla JavaScript. Uses WebSocket signaling for discovery and WebRTC Data Channels for direct, encrypted peer-to-peer communication. All cryptography is handled client-side using the Web Crypto API.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Browser A                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ ECDSA P-256  │  │ ECDH P-256   │  │ AES-256-GCM E2EE   │    │
│  │ Identity Key │  │ Key Exchange │  │ Payload Encryption  │    │
│  └──────────────┘  └──────────────┘  └────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              WebRTC DataChannel (DTLS)                   │    │
│  └──────────────────────────┬──────────────────────────────┘    │
└─────────────────────────────┼───────────────────────────────────┘
                              │ Direct P2P
                              │ (STUN/TURN assisted)
┌─────────────────────────────┼───────────────────────────────────┐
│  ┌──────────────────────────┴──────────────────────────────┐    │
│  │              WebRTC DataChannel (DTLS)                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ ECDSA P-256  │  │ ECDH P-256   │  │ AES-256-GCM E2EE   │    │
│  │ Identity Key │  │ Key Exchange │  │ Payload Encryption  │    │
│  └──────────────┘  └──────────────┘  └────────────────────┘    │
│                      Browser B                                  │
└─────────────────────────────────────────────────────────────────┘

           │                                   ▲
           │ WebSocket (signaling only)        │
           ▼                                   │
    ┌──────────────────────────────────┐
    │       Signaling Server           │
    │  (Offer/Answer/ICE relay only)   │
    │  Zero knowledge of payloads      │
    └──────────────────────────────────┘
```

## Features

- **Peer-to-Peer Connections** — WebRTC Data Channels for direct communication; no server relay of user data
- **End-to-End Encryption** — ECDH P-256 key agreement → HKDF-SHA256 derivation → AES-256-GCM encryption of all chat messages and file payloads
- **Signed Messages** — ECDSA P-256 digital signatures on every chat message with verification
- **Reliable File Transfer** — 256 KB chunked transfer with per-chunk SHA-256 integrity verification, streamed to disk via File System Access API
- **Transfer Controls** — Progress bars, cancellation support with cleanup of partial files
- **Decentralized Identity** — Auto-generated ECDSA keypairs; Peer ID = SHA-256(SPKI public key)
- **Network Diagnostics** — ICE candidate type logging (host/srflx/relay) and active candidate pair reporting

## Project Structure

```
p2p/
├── package.json                  # Root: ws dependency, npm start
├── readme.md
├── p2p-basic/
│   ├── client/
│   │   ├── index.html            # Main UI
│   │   ├── style.css             # Styling
│   │   ├── test.html             # Crypto unit tests
│   │   └── js/
│   │       ├── app.js            # Application entry point
│   │       ├── core/
│   │       │   ├── config.js     # Dynamic signaling URL, ICE servers
│   │       │   ├── crypto.js     # AES-GCM encrypt/decrypt, HKDF
│   │       │   ├── identity.js   # ECDSA keypair generation, peer ID
│   │       │   ├── keyExchange.js# ECDH key agreement
│   │       │   └── state.js      # Peer state management
│   │       ├── chat/             # Chat message handling
│   │       ├── signaling/        # WebSocket signaling client
│   │       ├── transfer/         # File transfer & cleanup
│   │       ├── ui/               # DOM rendering
│   │       ├── webrtc/           # Peer connection & data channel
│   │       └── tests/            # Crypto unit tests
│   └── server/
│       └── server.js             # Signaling server (HTTP + WebSocket)
```

## Setup & Running

### Prerequisites

- Node.js 18+ installed

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Signaling Server

```bash
npm start
```

The signaling server starts on `http://0.0.0.0:3000` (WebSocket on same port).

### 3. Serve the Client

In a separate terminal:

```bash
npx serve p2p-basic/client
```

Open `http://localhost:3000` (or whichever port `serve` reports) in two browser tabs.

## Network Deployment Guide

### Same Machine (Development)

Both tabs connect to `ws://<page-host>:3000` automatically (which is `ws://localhost:3000` on localhost). No configuration needed.

### Same LAN (Wi-Fi / Ethernet)

When you access the client from a LAN IP (e.g., `http://192.168.1.100:8080`), the signaling URL auto-resolves to `ws://192.168.1.100:3000`.

1. Find your local IP:
   ```bash
   # Windows
   ipconfig
   # macOS/Linux
   ifconfig | grep "inet "
   ```

2. Start the signaling server (it binds to `0.0.0.0` by default):
   ```bash
   npm start
   ```

3. Serve the client on all interfaces:
   ```bash
   npx serve p2p-basic/client -l tcp://0.0.0.0:8080
   ```

4. On both devices, open `http://<YOUR_LAN_IP>:8080`

> **Note:** Web Crypto API and WebRTC require a **secure context** (`https://` or `localhost`). When using a plain HTTP LAN IP, enable this Chrome flag on each device:
>
> ```
> chrome://flags/#unsafely-treat-insecure-origin-as-secure
> ```
>
> Add your LAN URL (e.g., `http://192.168.1.100:8080`) and restart Chrome.

### Internet / Production Deployment

For Internet-facing deployments, you need:

1. **HTTPS for the client** (required by Web Crypto API)
2. **WSS for signaling** (required when page is served over HTTPS)

#### Using a Reverse Proxy (Nginx)

```nginx
server {
    listen 443 ssl;
    server_name p2p.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # Serve client files
    location / {
        root /path/to/p2p-basic/client;
        index index.html;
    }

    # Proxy WebSocket signaling
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

Then configure the client to use the WSS endpoint:

```html
<script>
  window.P2P_CONFIG = { SIGNALING_URL: "wss://p2p.example.com/ws" };
</script>
```


## Environment Variables & Configuration

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | HTTP/WebSocket listen port |
| `HOST`   | `0.0.0.0` | Bind address |

### Client

The signaling URL is read from `window.P2P_CONFIG.SIGNALING_URL`; if omitted, it is derived as `ws(s)://<current_hostname>:3000`. ICE servers are set through `window.P2P_CONFIG.ICE_SERVERS` (an array of `RTCIceServer` objects). `window.ENV` is retained only as a compatibility alias.

## STUN / TURN Configuration

By default, the app uses STUN only:

- **STUN:** `stun:stun.l.google.com:19302` — For NAT traversal (discovers public IP)
- **TURN:** Not bundled. Configure an organization-controlled TURN service at deployment time when relay fallback is required.

**Same LAN:** STUN/TURN are usually unnecessary (direct `host` candidates work).

**Across NATs:** STUN enables `srflx` (server reflexive) candidates. If both peers are behind symmetric NATs, a TURN relay is required.

For production, deploy your own [coturn](https://github.com/coturn/coturn) or managed TURN service with TLS and short-lived credentials. Do not use static `user:password` credentials in a checked-in client file.

Then override in the client:

```html
<script>
  window.P2P_CONFIG = {
    ICE_SERVERS: [
      { urls: "stun:stun.example.com:3478" },
      { urls: "turns:turn.example.com:5349", username: "short-lived-user", credential: "short-lived-secret" }
    ]
  };
</script>
```

## Server Health Endpoint

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "uptimeSeconds": 3600,
  "registeredPeers": 2,
  "connectedSockets": 2,
  "timestamp": "2026-09-06T14:00:00.000Z"
}
```

## Security Model

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| Identity | ECDSA P-256 keypairs | Per-session identity, peer ID derivation |
| Authentication | ECDSA digital signatures | Message authenticity & tamper detection |
| Key Agreement | ECDH P-256 | Session key establishment between peers |
| Key Derivation | HKDF-SHA256 | Derive AES key from ECDH shared secret |
| Payload Encryption | AES-256-GCM | E2EE for chat messages and file chunks |
| Transport | WebRTC DTLS | Channel-level encryption |
| File Integrity | SHA-256 per chunk | Chunk-level corruption detection |

The signaling server only relays WebRTC offers, answers, and ICE candidates. It has **zero access** to decrypted chat messages or file contents.

## Network Diagnostics

The browser console logs ICE candidate types and connection state transitions:

```
[ICE] Local candidate gathered for peer abc123 [type: host]: candidate:...
[ICE] Connection state with abc123: checking
[ICE] Connection state with abc123: connected
[WebRTC] Active candidate pair for abc123: Local (host, udp) <-> Remote (host, udp)
```

Candidate types:
- **host** — Direct LAN connection (best performance)
- **srflx** — Server reflexive via STUN (NAT traversal)
- **relay** — TURN relay (last resort, adds latency)
## Step 7: deployment and real-network operation

### Runtime configuration

The client loads `p2p-basic/client/runtime-config.js` before the application bundle. Deploy a different version of that small configuration file for each environment; application source code does not need to change. `runtime-config.example.js` is a safe template.

| Setting | Development | Production |
| --- | --- | --- |
| `SIGNALING_URL` | Omit it: resolves to `ws://<page-host>:3000` | `wss://signal.example.com/ws` |
| `SIGNALING_PORT` | `3000` (default) | Only for a non-standard direct signaling port |
| `ICE_SERVERS` | STUN-only default | Organization-controlled STUN plus TURN, if required |

Do not use the query string as a signaling configuration channel. An HTTPS page rejects a `ws://` signaling URL to avoid mixed-content downgrade. The legacy `window.ENV` object remains compatible, but `window.P2P_CONFIG` is the preferred deployment interface.

### Same-LAN setup

1. Find the laptop LAN address (for example `192.168.1.100`) with `ipconfig`.
2. Run `npm install` once, then start signaling: `npm start`. It binds to `0.0.0.0:3000`.
3. Serve the frontend on all interfaces, never with `file://`: `npx serve p2p-basic/client -l tcp://0.0.0.0:8080`.
4. On the phone and laptop, open `http://192.168.1.100:8080`. The client automatically connects to `ws://192.168.1.100:3000`.
5. Allow the two ports through the laptop firewall on the private network.

Web Crypto requires a secure context. `localhost` is trusted by browsers, but a LAN IP served over plain HTTP normally is not. Prefer HTTPS even on LAN; Chrome's insecure-origin flag is a development-only workaround and must not be used for public deployment.

### Internet deployment

Use an HTTPS reverse proxy/CDN for the static client and a WSS reverse proxy to the Node signaling process. The signaling server handles only `register`, `discover`, `offer`, `answer`, and `candidate`; it never relays chat or file bytes.

```nginx
location / { root /srv/p2p-basic/client; try_files $uri $uri/ /index.html; }
location /ws {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

Set `ALLOWED_ORIGINS=https://p2p.example.com` for a cross-host frontend/signaling deployment. By default, WebSocket upgrades are accepted only from the same hostname (ports may differ), which supports the LAN procedure without an origin wildcard. HTTPS frontend plus WSS signaling is mandatory in production; do not send credentials or sensitive data through cleartext HTTP/WS.

### ICE, STUN, and TURN

The preferred candidate path is `host` (same LAN), then `srflx` (STUN), then `relay` (TURN). The application gathers and routes all ICE candidates and logs candidate types plus the selected pair in the development console. It intentionally does not log candidate addresses or SDP.

The repository now has no bundled TURN credential and does not claim a public TURN provider is production-ready. Provide TURN with `ICE_SERVERS` only after selecting a provider or operating coturn. Use TLS (`turns:` where supported), restrict relay firewall/ports, and issue time-limited credentials from a protected service; browser-delivered TURN credentials are necessarily visible to the connecting user and must not be long-lived. Never commit that runtime configuration if it contains credentials.

### Signaling service controls

`server.js` provides `/health`, 64 KiB message limits (configurable with `MAX_SIGNALING_MESSAGE_BYTES`), one-minute per-socket rate limits (`MAX_MESSAGES_PER_WINDOW`, default 60), malformed-message rejection, strict 64-hex peer-ID registration, duplicate-peer replacement, heartbeat cleanup, graceful SIGINT/SIGTERM shutdown, origin checking, and structured metadata-only logs. It overwrites the client-supplied `from` field, so a socket cannot relay a signaling message as another peer.

### Test matrix and current evidence

| Scenario | Status | Notes |
| --- | --- | --- |
| Same browser/device | Not run in this environment | Run two tabs and inspect WebRTC/ICE logs. |
| Two laptops, same LAN | Not run | Expected `host`; follow LAN setup. |
| Laptop and phone, same Wi-Fi | Not run | Requires secure-context handling on the phone. |
| Different networks | Not run | Requires deployed HTTPS/WSS and usually STUN; TURN may be needed. |
| Three peers | Not run | UI limit remains four peers. |
| Peer/server restart and reconnect | Code-reviewed | Signaling client uses capped exponential reconnect. |
| Forced WebRTC failure / TURN relay | Not run | Inspect console selected candidate type. |

For every manual run, record signaling state, WebRTC state, selected candidate type, transfer result, and approximate throughput. Throughput settings (256 KiB chunks, AES-GCM, hashing, buffering/backpressure) were deliberately not changed in this step.

### Before public deployment

Obtain DNS and TLS certificates; deploy HTTPS/WSS; set the explicit allowed frontend origin; choose and secure a TURN service; supply its short-lived credentials at runtime; configure firewall/security groups; add operational monitoring around `/health`; and execute the test matrix on real devices and hostile NATs. Internet connectivity has not been tested from this repository environment and is not claimed.

## Step 7.5: AWS serverless signaling

### Architecture and data boundary

```
Browser -- HTTPS --> S3/CloudFront static frontend
Browser -- WSS ---> API Gateway WebSocket --> one Lambda --> DynamoDB presence
                                             |-> API Gateway Management API -> other browser

Browser A ================= WebRTC DataChannel ================= Browser B
```

AWS carries only WebSocket presence and WebRTC signaling (offers, answers, and ICE candidates). Lambda never creates a peer connection and DynamoDB never stores files, chat, plaintext, AES keys, ECDH private keys, ECDSA private keys, or session state. Chat and file bytes remain on the browser-to-browser WebRTC data path.

### Migration map

| Previous Node behavior | AWS replacement |
| --- | --- |
| WebSocket connection / close | API Gateway `$connect` / `$disconnect` routes |
| `register`, duplicate-peer replacement | Lambda plus DynamoDB connection and peer records |
| `discover`, peer presence | Lambda query of DynamoDB `OnlinePeers` index |
| offer / answer / candidate routing | Browser `signal` envelope, Lambda, Management API `@connections` |
| in-memory identity binding | Persistent `connectionId` ↔ `peerId` records in DynamoDB |
| ping/pong liveness | API Gateway connection state plus browser 60-second application heartbeat, TTL assistance, and reconnect |
| rate/payload limits | API Gateway stage throttling plus Lambda 64 KiB body and message validation |

The deployed API has exactly five route keys: `$connect`, `$disconnect`, `register`, `discover`, and `signal`; all use one Lambda function. The client still receives ordinary `offer`, `answer`, and `candidate` messages, so no WebRTC or E2EE protocol changes are required.

### DynamoDB schema

The `PresenceTable` is pay-per-request and contains two records per registered peer:

- `pk=CONNECTION#<connectionId>, sk=META` → authoritative `peerId` binding.
- `pk=PEER#<peerId>, sk=META` → `connectionId`, limited `info`, `lastSeen`, `ttl`, and `gsi1pk=ONLINE`.

The `OnlinePeers` GSI queries online peers without a table scan. TTL is only stale-record assistance; it is not used as immediate disconnect detection.

### Identity-spoofing protection

For every `signal`, Lambda looks up `event.requestContext.connectionId` in DynamoDB and creates the forwarded `from` value from that binding. It ignores any client-provided `from`. Thus, a connection owned by Alice cannot claim its signal came from Bob. A Gone/410 target connection triggers stale-presence cleanup rather than a Lambda failure. CloudWatch logs contain route and truncated peer metadata only—never the signaling body, SDP, ICE candidate text, files, chat, or cryptographic material.

### Deploy

Prerequisites: AWS CLI credentials for a development account, AWS SAM CLI, Docker (if SAM asks to use a container), Node.js 20+, and an S3 bucket/CloudFront distribution or equivalent HTTPS static hosting.

```powershell
npm install
sam build --template-file infrastructure/template.yaml
sam deploy --guided --template-file infrastructure/template.yaml
```

During deployment, set `AllowedOrigins` to the exact HTTPS frontend origin, for example `https://your-site.cloudfront.net`. Copy the `WebSocketUrl` output into the deployed frontend's `runtime-config.js`:

```js
window.P2P_CONFIG = {
  SIGNALING_BACKEND: "aws-apigateway",
  SIGNALING_URL: "wss://your-api-id.execute-api.ap-south-1.amazonaws.com",
  ICE_SERVERS: [{ urls: "stun:stun.l.google.com:19302" }]
};
```

Do not place TURN credentials in this file. Obtain short-lived TURN credentials through a separately protected production mechanism. For local Node signaling, omit `SIGNALING_BACKEND`; it defaults to `node` and continues using the existing direct signaling message format.

To host the static frontend, upload the contents of `p2p-basic/client` to an HTTPS S3/CloudFront origin, ensuring its production `runtime-config.js` contains the WebSocket endpoint. A CloudFront invalidation is needed after changing that file.

### Testing and operation

```powershell
npm test
aws logs tail /aws/lambda/<stack-name>-SignalingFunction-<suffix> --follow
aws cloudformation delete-stack --stack-name <development-stack-name>
```

Automated tests cover origin rejection, invalid IDs, discovery without connection-ID disclosure, malformed and oversized messages, disconnect cleanup, and the critical sender-spoofing case. Before public release, manually use two HTTPS browser clients to confirm registration, presence events, offer/answer/candidate delivery, WebRTC connection, encrypted chat, encrypted file transfer, reconnect, duplicate registration, and TURN relay behavior.

### Cost assumptions

The stack is low-traffic oriented: API Gateway WebSocket bills connection-minutes and messages, Lambda bills requests/duration, DynamoDB uses on-demand reads/writes, and CloudWatch bills retained logs. At 100 daily users it is usually low single-digit USD/month excluding static egress and TURN; at 1,000 users, connection duration and message volume dominate; at 10,000 users, obtain a region-specific estimate using actual average session minutes, signaling messages, and CloudWatch retention. TURN relay bandwidth can exceed signaling cost and is not included. Prices and free tiers vary by region and date, so this is not a price quote.
