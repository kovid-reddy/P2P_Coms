/* Copy/deploy as runtime-config.js. Do not commit real TURN credentials. */
window.P2P_CONFIG = {
    // Local: omit SIGNALING_URL and it resolves to ws://<page-host>:3000.
    // Production: API Gateway WebSocket endpoint, for example:
    // SIGNALING_URL: "wss://abc123.execute-api.ap-south-1.amazonaws.com",
    // SIGNALING_BACKEND: "aws-apigateway",
    SIGNALING_URL: "",
    ICE_SERVERS: [
        { urls: "stun:stun.example.com:3478" },
        // Obtain this from an authenticated, short-lived credential service:
        // { urls: "turns:turn.example.com:5349?transport=tcp", username: "", credential: "" }
    ]
};
