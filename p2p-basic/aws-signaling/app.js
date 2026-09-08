"use strict";

const { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, DeleteItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { ApiGatewayManagementApiClient, PostToConnectionCommand, DeleteConnectionCommand } = require("@aws-sdk/client-apigatewaymanagementapi");

const PEER_ID_RE = /^[a-f0-9]{64}$/i;
const MAX_BYTES = 64 * 1024;

const attr = (value) => ({ S: value });
const nowSeconds = () => Math.floor(Date.now() / 1000);
const metadata = (peerId) => peerId.slice(0, 12);

function safeLog(event, fields = {}) {
    // Deliberately exclude bodies, SDP, ICE candidates, credentials and keys.
    console.log(JSON.stringify({ event, time: new Date().toISOString(), ...fields }));
}

function response(statusCode = 200, body = "") {
    return { statusCode, body };
}

function parseBody(event) {
    if (!event.body || Buffer.byteLength(event.body, "utf8") > MAX_BYTES) throw new Error("Invalid or oversized payload");
    const body = JSON.parse(event.body);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.type !== "string") throw new Error("Invalid message format");
    return body;
}

function allowedOrigin(event, allowedOrigins) {
    if (!allowedOrigins.length) return true;
    return allowedOrigins.includes(event.headers?.origin || event.headers?.Origin);
}

function endpoint(event) {
    const domain = event.requestContext.domainName;
    const stage = event.requestContext.stage;
    return `https://${domain}/${stage}`;
}

function createHandler(deps = {}) {
    const db = deps.db || new DynamoDBClient({});
    const managementFactory = deps.managementFactory || ((event) => new ApiGatewayManagementApiClient({ endpoint: endpoint(event) }));
    const table = deps.table || process.env.PRESENCE_TABLE;
    const ttlSeconds = Number(deps.ttlSeconds || process.env.PRESENCE_TTL_SECONDS || 7200);
    const origins = (deps.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);

    const getConnection = async (connectionId) => {
        const result = await db.send(new GetItemCommand({ TableName: table, Key: { pk: attr(`CONNECTION#${connectionId}`), sk: attr("META") }, ConsistentRead: true }));
        return result.Item;
    };
    const getPeer = async (peerId) => {
        const result = await db.send(new GetItemCommand({ TableName: table, Key: { pk: attr(`PEER#${peerId}`), sk: attr("META") }, ConsistentRead: true }));
        return result.Item;
    };
    const send = async (event, connectionId, message) => {
        try {
            await managementFactory(event).send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(message)) }));
            return true;
        } catch (error) {
            if (error.name === "GoneException" || error.$metadata?.httpStatusCode === 410) {
                await cleanup(event, connectionId, "stale_connection");
                return false;
            }
            throw error;
        }
    };
    const peersOnline = async () => {
        const result = await db.send(new QueryCommand({ TableName: table, IndexName: "OnlinePeers", KeyConditionExpression: "gsi1pk = :online", ExpressionAttributeValues: { ":online": attr("ONLINE") } }));
        return result.Items || [];
    };
    const touch = async (connectionId, peerId) => {
        const expires = nowSeconds() + ttlSeconds;
        await Promise.all([
            db.send(new UpdateItemCommand({ TableName: table, Key: { pk: attr(`CONNECTION#${connectionId}`), sk: attr("META") }, UpdateExpression: "SET ttl = :ttl", ExpressionAttributeValues: { ":ttl": { N: String(expires) } } })),
            db.send(new UpdateItemCommand({ TableName: table, Key: { pk: attr(`PEER#${peerId}`), sk: attr("META") }, UpdateExpression: "SET lastSeen = :seen, ttl = :ttl", ExpressionAttributeValues: { ":seen": attr(String(nowSeconds())), ":ttl": { N: String(expires) } } }))
        ]);
    };
    const notify = async (event, message, excludeConnectionId) => {
        const online = await peersOnline();
        await Promise.all(online.filter((peer) => peer.connectionId.S !== excludeConnectionId).map((peer) => send(event, peer.connectionId.S, message)));
    };
    const cleanup = async (event, connectionId, reason) => {
        const binding = await getConnection(connectionId);
        if (!binding?.peerId?.S) return;
        const peerId = binding.peerId.S;
        const peer = await getPeer(peerId);
        await db.send(new DeleteItemCommand({ TableName: table, Key: { pk: attr(`CONNECTION#${connectionId}`), sk: attr("META") } }));
        // A newer duplicate registration wins; never remove its peer record.
        if (peer?.connectionId?.S === connectionId) {
            await db.send(new DeleteItemCommand({ TableName: table, Key: { pk: attr(`PEER#${peerId}`), sk: attr("META") } }));
            await notify(event, { type: "peer-left", peerId }, connectionId);
        }
        safeLog("peer_removed", { peerId: metadata(peerId), reason });
    };

    return async (event) => {
        const route = event.requestContext?.routeKey;
        const connectionId = event.requestContext?.connectionId;
        try {
            if (route === "$connect") {
                if (!allowedOrigin(event, origins)) return response(403, "Origin not allowed");
                safeLog("connected", { connectionId });
                return response();
            }
            if (route === "$disconnect") {
                await cleanup(event, connectionId, "disconnect");
                return response();
            }
            if (!["register", "discover", "signal"].includes(route)) return response(400, "Unsupported route");
            const body = parseBody(event);
            if (body.type !== route) return response(400, "Route/message mismatch");

            if (route === "register") {
                if (!PEER_ID_RE.test(body.peerId || "")) return response(400, "Invalid peer ID");
                const existing = await getPeer(body.peerId);
                // Capture current presence before publishing this peer. The
                // registering connection needs this explicit snapshot; a
                // peer-joined broadcast alone only informs existing peers.
                const onlineBeforeRegistration = await peersOnline();
                const info = typeof body.info === "string" ? body.info.slice(0, 128) : "webrtc";
                const expires = nowSeconds() + ttlSeconds;
                if (existing?.connectionId?.S && existing.connectionId.S !== connectionId) {
                    await db.send(new DeleteItemCommand({ TableName: table, Key: { pk: attr(`CONNECTION#${existing.connectionId.S}`), sk: attr("META") } }));
                    await send(event, existing.connectionId.S, { type: "error", message: "Replaced by newer connection" });
                    safeLog("duplicate_peer_replaced", { peerId: metadata(body.peerId) });
                }
                await db.send(new PutItemCommand({ TableName: table, Item: { pk: attr(`PEER#${body.peerId}`), sk: attr("META"), connectionId: attr(connectionId), peerId: attr(body.peerId), info: attr(info), status: attr("online"), gsi1pk: attr("ONLINE"), gsi1sk: attr(body.peerId), lastSeen: attr(String(nowSeconds())), ttl: { N: String(expires) } } }));
                await db.send(new PutItemCommand({ TableName: table, Item: { pk: attr(`CONNECTION#${connectionId}`), sk: attr("META"), peerId: attr(body.peerId), ttl: { N: String(expires) } } }));
                await send(event, connectionId, {
                    type: "peer-list",
                    peers: onlineBeforeRegistration
                        .filter((peer) => peer.peerId.S !== body.peerId)
                        .map((peer) => ({ peerId: peer.peerId.S, info: peer.info.S }))
                });
                await notify(event, { type: "peer-joined", peerId: body.peerId, info }, connectionId);
                await send(event, connectionId, { type: "registered", peerId: body.peerId });
                safeLog("registered", { peerId: metadata(body.peerId) });
                return response();
            }

            const binding = await getConnection(connectionId);
            if (!binding?.peerId?.S) return response(401, "Register first");
            const sender = binding.peerId.S;
            if (route === "discover") {
                await touch(connectionId, sender);
                const online = await peersOnline();
                await send(event, connectionId, { type: "peer-list", peers: online.filter((peer) => peer.peerId.S !== sender).map((peer) => ({ peerId: peer.peerId.S, info: peer.info.S })) });
                return response();
            }

            const signal = body.signal;
            if (signal?.type === "heartbeat") {
                await touch(connectionId, sender);
                return response();
            }
            if (!signal || !["offer", "answer", "candidate"].includes(signal.type) || !PEER_ID_RE.test(body.target || "") || !signal[signal.type] || typeof signal[signal.type] !== "object") return response(400, "Invalid signal");
            const target = await getPeer(body.target);
            if (!target?.connectionId?.S) return response(404, "Target unavailable");
            // `from` is intentionally constructed from the DynamoDB connection binding.
            const delivered = await send(event, target.connectionId.S, { type: signal.type, from: sender, target: body.target, [signal.type]: signal[signal.type] });
            if (delivered) safeLog("signal_relayed", { type: signal.type, from: metadata(sender), target: metadata(body.target) });
            return response();
        } catch (error) {
            safeLog("request_rejected", { route, error: error.message });
            return response(error instanceof SyntaxError || /Invalid|Route|Unsupported/.test(error.message) ? 400 : 500, "Request rejected");
        }
    };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
