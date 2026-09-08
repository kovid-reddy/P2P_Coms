import test from "node:test";
import assert from "node:assert/strict";
import { peers, discoveredPeers, getActivePeerId, markPeerConnected, setActivePeerId } from "./state.js";

function resetState() {
    peers.clear();
    discoveredPeers.clear();
    setActivePeerId(null);
}

test("a connected peer is visible once and becomes active when no peer is selected", () => {
    resetState();
    const first = markPeerConnected("peer-a");
    const second = markPeerConnected("peer-a");

    assert.equal(first.becameActive, true);
    assert.equal(second.becameActive, false);
    assert.equal(getActivePeerId(), "peer-a");
    assert.equal(discoveredPeers.size, 1);
    assert.equal(peers.get("peer-a").networkState, "connected");
});

test("a new incoming connection does not replace the user's active peer", () => {
    resetState();
    markPeerConnected("peer-a");
    setActivePeerId("peer-a");
    const result = markPeerConnected("peer-b");

    assert.equal(result.becameActive, false);
    assert.equal(getActivePeerId(), "peer-a");
    assert.equal(discoveredPeers.size, 2);
});
