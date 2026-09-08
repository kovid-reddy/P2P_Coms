"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("./app.js");

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const event = (routeKey, body, connectionId = "connection-a") => ({
    body: body === undefined ? null : JSON.stringify(body),
    headers: { origin: "https://app.example.com" },
    requestContext: { routeKey, connectionId, domainName: "api.example.com", stage: "$default" }
});
const item = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { S: value }]));

function harness({ get = () => undefined, query = () => [], gone = false } = {}) {
    const posted = [];
    const deleted = [];
    const db = { send: async (command) => {
        const input = command.input;
        if (command.constructor.name === "GetItemCommand") return { Item: get(input.Key.pk.S) };
        if (command.constructor.name === "QueryCommand") return { Items: query() };
        if (command.constructor.name === "DeleteItemCommand") deleted.push(input.Key.pk.S);
        return {};
    } };
    const managementFactory = () => ({ send: async (command) => {
        if (gone) { const error = new Error("gone"); error.name = "GoneException"; throw error; }
        posted.push({ connectionId: command.input.ConnectionId, body: JSON.parse(Buffer.from(command.input.Data).toString()) });
    } });
    return { handler: createHandler({ db, managementFactory, table: "test", allowedOrigins: "https://app.example.com" }), posted, deleted };
}

function presenceHarness() {
    const records = new Map();
    const posted = [];
    const db = { send: async (command) => {
        const input = command.input;
        if (command.constructor.name === "GetItemCommand") return { Item: records.get(input.Key.pk.S) };
        if (command.constructor.name === "PutItemCommand") { records.set(input.Item.pk.S, input.Item); return {}; }
        if (command.constructor.name === "DeleteItemCommand") { records.delete(input.Key.pk.S); return {}; }
        if (command.constructor.name === "QueryCommand") return { Items: [...records.values()].filter((record) => record.gsi1pk?.S === "ONLINE") };
        return {};
    } };
    const managementFactory = () => ({ send: async (command) => posted.push({ connectionId: command.input.ConnectionId, body: JSON.parse(Buffer.from(command.input.Data).toString()) }) });
    const handler = createHandler({ db, managementFactory, table: "test", allowedOrigins: "https://app.example.com" });
    const messagesFor = (connectionId) => posted.filter((message) => message.connectionId === connectionId).map((message) => message.body);
    const clearMessages = () => { posted.length = 0; };
    return { handler, messagesFor, clearMessages };
}

test("$connect enforces the configured origin", async () => {
    const { handler } = harness();
    const denied = await handler({ ...event("$connect"), headers: { origin: "https://evil.example" } });
    assert.equal(denied.statusCode, 403);
    assert.equal((await handler(event("$connect"))).statusCode, 200);
});

test("register rejects an invalid peer ID", async () => {
    const { handler } = harness();
    assert.equal((await handler(event("register", { type: "register", peerId: "bad" }))).statusCode, 400);
});

test("a newer duplicate registration replaces the old connection safely", async () => {
    const { handler, posted, deleted } = harness({ get: (key) => key.includes(`PEER#${ALICE}`) ? item({ connectionId: "old-connection" }) : undefined, query: () => [] });
    assert.equal((await handler(event("register", { type: "register", peerId: ALICE }, "new-connection"))).statusCode, 200);
    assert.ok(deleted.includes("CONNECTION#old-connection"));
    assert.deepEqual(posted[0], { connectionId: "old-connection", body: { type: "error", message: "Replaced by newer connection" } });
});

test("discover returns online peers without connection IDs", async () => {
    const { handler, posted } = harness({
        get: (key) => key.includes("connection-a") ? item({ peerId: ALICE }) : undefined,
        query: () => [item({ peerId: ALICE, connectionId: "connection-a", info: "webrtc" }), item({ peerId: BOB, connectionId: "connection-b", info: "webrtc" })]
    });
    assert.equal((await handler(event("discover", { type: "discover" }))).statusCode, 200);
    assert.deepEqual(posted[0], { connectionId: "connection-a", body: { type: "peer-list", peers: [{ peerId: BOB, info: "webrtc" }] } });
});

test("signal routing derives sender from connection binding, not spoofable JSON from", async () => {
    const { handler, posted } = harness({
        get: (key) => key.includes("connection-a") ? item({ peerId: ALICE }) : key.includes(`PEER#${BOB}`) ? item({ connectionId: "connection-b" }) : undefined
    });
    const result = await handler(event("signal", { type: "signal", from: BOB, target: BOB, signal: { type: "candidate", candidate: { candidate: "opaque" } } }));
    assert.equal(result.statusCode, 200);
    assert.equal(posted[0].connectionId, "connection-b");
    assert.equal(posted[0].body.from, ALICE);
    assert.equal(posted[0].body.candidate.candidate, "opaque");
});

test("signal rejects malformed payloads and invalid targets", async () => {
    const { handler } = harness({ get: () => item({ peerId: ALICE }) });
    assert.equal((await handler(event("signal", { type: "signal", target: "bad", signal: { type: "offer", offer: {} } }))).statusCode, 400);
    assert.equal((await handler({ ...event("signal", { type: "signal" }), body: "{" })).statusCode, 400);
});

test("heartbeat touches registered presence without forwarding a signal", async () => {
    const { handler, posted } = harness({ get: () => item({ peerId: ALICE }) });
    assert.equal((await handler(event("signal", { type: "signal", signal: { type: "heartbeat" } }))).statusCode, 200);
    assert.equal(posted.length, 0);
});

test("stale target connection is cleaned up instead of failing routing", async () => {
    const { handler, deleted } = harness({
        gone: true,
        get: (key) => key.includes("connection-a") ? item({ peerId: ALICE }) : key.includes(`PEER#${BOB}`) ? item({ connectionId: "connection-b" }) : key.includes("connection-b") ? item({ peerId: BOB }) : undefined,
        query: () => []
    });
    assert.equal((await handler(event("signal", { type: "signal", target: BOB, signal: { type: "offer", offer: {} } }))).statusCode, 200);
    assert.ok(deleted.includes("CONNECTION#connection-b"));
});

test("disconnect removes the authoritative connection mapping", async () => {
    const { handler, deleted } = harness({
        get: (key) => key.includes("connection-a") ? item({ peerId: ALICE }) : key.includes(`PEER#${ALICE}`) ? item({ connectionId: "connection-a" }) : undefined,
        query: () => []
    });
    assert.equal((await handler(event("$disconnect", undefined))).statusCode, 200);
    assert.deepEqual(deleted.sort(), [`CONNECTION#connection-a`, `PEER#${ALICE}`].sort());
});

test("oversized message is rejected before processing", async () => {
    const { handler } = harness();
    const result = await handler({ ...event("register", { type: "register" }), body: "x".repeat(65 * 1024) });
    assert.equal(result.statusCode, 400);
});

test("registration gives each new peer the current presence snapshot and broadcasts the new peer", async () => {
    const { handler, messagesFor, clearMessages } = presenceHarness();
    await handler(event("register", { type: "register", peerId: ALICE }, "connection-a"));
    assert.deepEqual(messagesFor("connection-a").find((message) => message.type === "peer-list").peers, []);

    clearMessages();
    await handler(event("register", { type: "register", peerId: BOB }, "connection-b"));
    assert.deepEqual(messagesFor("connection-b").find((message) => message.type === "peer-list").peers, [{ peerId: ALICE, info: "webrtc" }]);
    assert.ok(messagesFor("connection-a").some((message) => message.type === "peer-joined" && message.peerId === BOB));

    const CAROL = "c".repeat(64);
    clearMessages();
    await handler(event("register", { type: "register", peerId: CAROL }, "connection-c"));
    assert.deepEqual(messagesFor("connection-c").find((message) => message.type === "peer-list").peers.map((peer) => peer.peerId).sort(), [ALICE, BOB].sort());
    assert.ok(messagesFor("connection-a").some((message) => message.type === "peer-joined" && message.peerId === CAROL));
    assert.ok(messagesFor("connection-b").some((message) => message.type === "peer-joined" && message.peerId === CAROL));

    clearMessages();
    await handler(event("$disconnect", undefined, "connection-c"));
    assert.ok(messagesFor("connection-a").some((message) => message.type === "peer-left" && message.peerId === CAROL));
    assert.ok(messagesFor("connection-b").some((message) => message.type === "peer-left" && message.peerId === CAROL));
});
