import { generateEcdhKeyPair, exportPublicKeySpki, signData, arrayBufferToBase64, generateNonce } from "./crypto.js";

let keyPair = null;
let publicKeyString = null;
let myId = null;

let ecdhKeyPair = null;
let ecdhPublicKeyString = null;

export async function generateIdentity() {
    if (typeof window !== "undefined" && !window.isSecureContext) {
        alert("This page must be served over HTTPS or localhost for Web Crypto and WebRTC to work.\n\n" +
            "If testing on a local network, enable this Chrome flag:\n" +
            "chrome://flags/#unsafely-treat-insecure-origin-as-secure\n" +
            "and add: " + (typeof location !== "undefined" ? location.origin : ""));
        return null;
    }

    // 1. ECDSA Identity Keypair (for signing and identity verification)
    keyPair = await crypto.subtle.generateKey(
        {
            name: "ECDSA",
            namedCurve: "P-256"
        },
        true,
        ["sign", "verify"]
    );

    const exported = await crypto.subtle.exportKey("spki", keyPair.publicKey);

    publicKeyString = btoa(
        String.fromCharCode(...new Uint8Array(exported))
    );

    myId = await hashString(publicKeyString);

    // 2. ECDH Keypair (for E2EE key agreement, separate from signing key)
    ecdhKeyPair = await generateEcdhKeyPair();
    ecdhPublicKeyString = await exportPublicKeySpki(ecdhKeyPair.publicKey);

    console.log("My Identity (Peer ID):", myId);
    return { keyPair, publicKeyString, myId, ecdhKeyPair, ecdhPublicKeyString };
}

export async function hashString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

export function getKeyPair() {
    return keyPair;
}

export function getPublicKeyString() {
    return publicKeyString;
}

export function getMyId() {
    return myId;
}

export function getEcdhKeyPair() {
    return ecdhKeyPair;
}

export function getEcdhPublicKeyString() {
    return ecdhPublicKeyString;
}

export async function createKeyExchangePayload() {
    if (!keyPair || !ecdhKeyPair || !ecdhPublicKeyString) {
        throw new Error("Identity or ECDH key not initialized");
    }

    const nonce = arrayBufferToBase64(generateNonce(12));
    const signedData = `${ecdhPublicKeyString}:${nonce}`;
    const signature = await signData(keyPair.privateKey, signedData);

    return {
        type: "key-exchange",
        identityPublicKey: publicKeyString,
        ecdhPublicKey: ecdhPublicKeyString,
        nonce: nonce,
        signature: signature
    };
}

export function isIdentityReady() {
    return Boolean(keyPair && publicKeyString && myId && ecdhKeyPair && ecdhPublicKeyString);
}

