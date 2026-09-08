/* Deployment configuration is loaded from /runtime-config.js before this
 * module. That file is separate from application code so a deploy can replace
 * it without rebuilding the client. window.ENV remains supported for existing
 * deployments. */
const runtimeConfig = (typeof window !== "undefined" && (window.P2P_CONFIG || window.ENV)) || {};

function configuredIceServers() {
    if (Array.isArray(runtimeConfig.ICE_SERVERS)) return runtimeConfig.ICE_SERVERS;

    // STUN is public discovery infrastructure, not a credential. No TURN
    // server is supplied by default; production must inject short-lived TURN
    // credentials through runtime configuration.
    return [{ urls: "stun:stun.l.google.com:19302" }];
}

function resolveSignalingUrl() {
    if (runtimeConfig.SIGNALING_URL) {
        const url = new URL(runtimeConfig.SIGNALING_URL, window.location.href);
        if (window.location.protocol === "https:" && url.protocol !== "wss:") {
            throw new Error("An HTTPS page requires a wss:// signaling URL.");
        }
        if (!["ws:", "wss:"].includes(url.protocol)) {
            throw new Error("SIGNALING_URL must use ws:// or wss://.");
        }
        return url.toString();
    }

    if (typeof window !== "undefined" && window.location?.hostname) {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const port = runtimeConfig.SIGNALING_PORT || "3000";
        return `${protocol}//${window.location.hostname}:${port}`;
    }

    throw new Error("No browser location or SIGNALING_URL is available.");
}

export const CONFIG = Object.freeze({
    get SIGNALING_URL() {
        return resolveSignalingUrl();
    },
    MAX_PEERS: 4,
    SIGNALING_BACKEND: runtimeConfig.SIGNALING_BACKEND || "node",
    CHUNK_SIZE: 256 * 1024,
    BUFFERED_AMOUNT_LOW_THRESHOLD: 4 * 1024 * 1024,
    iceServers: configuredIceServers()
});
