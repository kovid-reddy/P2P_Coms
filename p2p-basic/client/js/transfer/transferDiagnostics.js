import { CONFIG } from "../core/config.js";
import { formatBytes } from "../core/state.js";

/**
 * Performance diagnostics instrumentation for file transfers.
 * Collects timing metrics per-chunk and produces a summary report.
 * Does NOT optimize — measurement only.
 */

export function createDiagnostics() {
    return {
        // Timing
        startTimeHR: null,       // performance.now() at first chunk
        endTimeHR: null,         // performance.now() at completion/abort

        // Chunk counters
        totalChunks: 0,
        totalBytes: 0,

        // Per-chunk timing arrays (ms)
        hashTimes: [],
        readTimes: [],           // sender: FileReader read time
        writeTimes: [],          // receiver: writableStream.write() time

        // Backpressure
        backpressureWaits: {
            count: 0,
            totalMs: 0
        },

        // Buffered amount samples (taken before each send on sender side)
        bufferedAmountSamples: [],

        // Throughput
        peakThroughputBps: 0,
        lastThroughputSampleTime: null,
        lastThroughputSampleBytes: 0,

        // Config snapshot
        chunkSize: CONFIG.CHUNK_SIZE,
        bufferedAmountLowThreshold: CONFIG.BUFFERED_AMOUNT_LOW_THRESHOLD,

        // ICE candidate type (populated at finalization)
        iceCandidateType: null
    };
}

export function recordChunkSent(diag, chunkSize, hashTimeMs, readTimeMs, bufferedAmount) {
    if (!diag) return;

    if (diag.startTimeHR === null) {
        diag.startTimeHR = performance.now();
        diag.lastThroughputSampleTime = diag.startTimeHR;
        diag.lastThroughputSampleBytes = 0;
    }

    diag.totalChunks++;
    diag.totalBytes += chunkSize;
    diag.hashTimes.push(hashTimeMs);
    diag.readTimes.push(readTimeMs);
    diag.bufferedAmountSamples.push(bufferedAmount);

    // Track peak throughput over 1-second windows
    updatePeakThroughput(diag);
}

export function recordChunkReceived(diag, chunkSize, hashTimeMs, writeTimeMs) {
    if (!diag) return;

    if (diag.startTimeHR === null) {
        diag.startTimeHR = performance.now();
        diag.lastThroughputSampleTime = diag.startTimeHR;
        diag.lastThroughputSampleBytes = 0;
    }

    diag.totalChunks++;
    diag.totalBytes += chunkSize;
    diag.hashTimes.push(hashTimeMs);
    diag.writeTimes.push(writeTimeMs);

    // Track peak throughput over 1-second windows
    updatePeakThroughput(diag);
}

export function recordBackpressureWait(diag, waitTimeMs) {
    if (!diag) return;
    diag.backpressureWaits.count++;
    diag.backpressureWaits.totalMs += waitTimeMs;
}

function updatePeakThroughput(diag) {
    const now = performance.now();
    const elapsed = (now - diag.lastThroughputSampleTime) / 1000;
    if (elapsed >= 1.0) {
        const bytesSinceSample = diag.totalBytes - diag.lastThroughputSampleBytes;
        const throughput = bytesSinceSample / elapsed;
        if (throughput > diag.peakThroughputBps) {
            diag.peakThroughputBps = throughput;
        }
        diag.lastThroughputSampleTime = now;
        diag.lastThroughputSampleBytes = diag.totalBytes;
    }
}

export async function resolveIceCandidateType(peerConnection) {
    if (!peerConnection || typeof peerConnection.getStats !== "function") {
        return "unknown";
    }
    try {
        const stats = await peerConnection.getStats();
        let selectedPairId = null;

        // Find the selected candidate pair
        for (const [, report] of stats) {
            if (report.type === "transport" && report.selectedCandidatePairId) {
                selectedPairId = report.selectedCandidatePairId;
                break;
            }
        }

        // Fallback: look for nominated candidate-pair directly
        if (!selectedPairId) {
            for (const [, report] of stats) {
                if (report.type === "candidate-pair" && (report.selected || report.nominated)) {
                    selectedPairId = report.id;
                    break;
                }
            }
        }

        if (!selectedPairId) return "unknown";

        const pair = stats.get(selectedPairId);
        if (!pair) return "unknown";

        // Get local candidate type
        const localCandidate = stats.get(pair.localCandidateId);
        const remoteCandidate = stats.get(pair.remoteCandidateId);

        const localType = localCandidate ? localCandidate.candidateType : "unknown";
        const remoteType = remoteCandidate ? remoteCandidate.candidateType : "unknown";

        return `local=${localType}, remote=${remoteType}`;
    } catch (e) {
        console.warn("Could not resolve ICE candidate type:", e);
        return "error";
    }
}

function computeArrayStats(arr) {
    if (!arr || arr.length === 0) {
        return { min: 0, max: 0, avg: 0, median: 0, total: 0, count: 0 };
    }
    const sorted = [...arr].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;

    return {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: sum / sorted.length,
        median: median,
        total: sum,
        count: sorted.length
    };
}

function computeBufferedAmountStats(samples) {
    if (!samples || samples.length === 0) {
        return { min: 0, max: 0, avg: 0 };
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    return { min, max, avg };
}

export function finalizeDiagnostics(diag, peerId, direction, peerConnection) {
    if (!diag) return;

    diag.endTimeHR = performance.now();

    // Resolve ICE type asynchronously and then log
    resolveIceCandidateType(peerConnection).then((iceType) => {
        diag.iceCandidateType = iceType;
        logPerformanceReport(diag, peerId, direction);
    });
}

function logPerformanceReport(diag, peerId, direction) {
    const totalDurationMs = diag.endTimeHR - (diag.startTimeHR || diag.endTimeHR);
    const totalDurationSec = totalDurationMs / 1000;
    const avgThroughput = totalDurationSec > 0 ? diag.totalBytes / totalDurationSec : 0;

    // Capture final peak (for transfers shorter than 1s)
    if (diag.peakThroughputBps === 0 && totalDurationSec > 0) {
        diag.peakThroughputBps = avgThroughput;
    }

    const hashStats = computeArrayStats(diag.hashTimes);
    const readStats = computeArrayStats(diag.readTimes);
    const writeStats = computeArrayStats(diag.writeTimes);
    const bufStats = computeBufferedAmountStats(diag.bufferedAmountSamples);

    const fmtMs = (v) => v.toFixed(2) + " ms";
    const fmtBytes = (v) => formatBytes(Math.round(v));

    const report = [
        "",
        "╔══════════════════════════════════════════════════════════════╗",
        "║            📊 TRANSFER PERFORMANCE REPORT                   ║",
        "╚══════════════════════════════════════════════════════════════╝",
        "",
        `  Peer:              ${peerId}`,
        `  Direction:         ${direction}`,
        `  ICE Candidate:     ${diag.iceCandidateType || "unknown"}`,
        "",
        "── Transfer Summary ──────────────────────────────────────────",
        `  Total bytes:       ${fmtBytes(diag.totalBytes)}`,
        `  Total chunks:      ${diag.totalChunks}`,
        `  Chunk size:        ${fmtBytes(diag.chunkSize)}`,
        `  Duration:          ${totalDurationSec.toFixed(3)} s`,
        `  Avg throughput:    ${fmtBytes(avgThroughput)}/s`,
        `  Peak throughput:   ${fmtBytes(diag.peakThroughputBps)}/s`,
        "",
        "── SHA-256 Hashing ───────────────────────────────────────────",
        `  Count:             ${hashStats.count}`,
        `  Min:               ${fmtMs(hashStats.min)}`,
        `  Max:               ${fmtMs(hashStats.max)}`,
        `  Avg:               ${fmtMs(hashStats.avg)}`,
        `  Median:            ${fmtMs(hashStats.median)}`,
        `  Total:             ${fmtMs(hashStats.total)}`,
    ];

    if (direction === "send") {
        report.push(
            "",
            "── File Read/Slice ───────────────────────────────────────────",
            `  Count:             ${readStats.count}`,
            `  Min:               ${fmtMs(readStats.min)}`,
            `  Max:               ${fmtMs(readStats.max)}`,
            `  Avg:               ${fmtMs(readStats.avg)}`,
            `  Median:            ${fmtMs(readStats.median)}`,
            `  Total:             ${fmtMs(readStats.total)}`,
            "",
            "── Backpressure ──────────────────────────────────────────────",
            `  Wait count:        ${diag.backpressureWaits.count}`,
            `  Total wait time:   ${fmtMs(diag.backpressureWaits.totalMs)}`,
            "",
            "── RTCDataChannel Buffered Amount ─────────────────────────────",
            `  Threshold:         ${fmtBytes(diag.bufferedAmountLowThreshold)}`,
            `  Samples:           ${diag.bufferedAmountSamples.length}`,
            `  Min:               ${fmtBytes(bufStats.min)}`,
            `  Max:               ${fmtBytes(bufStats.max)}`,
            `  Avg:               ${fmtBytes(bufStats.avg)}`,
        );
    }

    if (direction === "receive") {
        report.push(
            "",
            "── Receiver Write Latency ────────────────────────────────────",
            `  Count:             ${writeStats.count}`,
            `  Min:               ${fmtMs(writeStats.min)}`,
            `  Max:               ${fmtMs(writeStats.max)}`,
            `  Avg:               ${fmtMs(writeStats.avg)}`,
            `  Median:            ${fmtMs(writeStats.median)}`,
            `  Total:             ${fmtMs(writeStats.total)}`,
        );
    }

    report.push(
        "",
        "══════════════════════════════════════════════════════════════",
        ""
    );

    console.log(report.join("\n"));
}
