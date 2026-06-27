/**
 * Node-side timing for CPU-heavy upload phases (no browser video probe).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/benchmark-upload-node.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
    chunkHashFinal,
    chunkHashInit,
    chunkHashUpdate,
    encryptStreamBytes,
    generateBlobOrStreamKey,
} from "ente-base/crypto";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(SCRIPT_DIR, "fixtures");
const LOG_PATH = join(SCRIPT_DIR, "..", "..", "debug-b43bb4.log");

const time = async (label: string, bytes: number, fn: () => Promise<void>): Promise<number> => {
    const start = performance.now();
    await fn();
    const ms = performance.now() - start;
    console.log(`  ${label.padEnd(24)} ${ms.toFixed(0).padStart(7)} ms  (${Math.round(bytes / 1024)} KB)`);
    return ms;
};

const hashAll = async (data: Uint8Array): Promise<void> => {
    const state = await chunkHashInit();
    await chunkHashUpdate(state, data);
    await chunkHashFinal(state);
};

const encryptAll = async (data: Uint8Array): Promise<void> => {
    const key = await generateBlobOrStreamKey();
    await encryptStreamBytes(data, key);
};

const main = async (): Promise<void> => {
    const files = [
        { label: "tiny MP4", path: join(FIXTURES, "bench-tiny.mp4") },
        { label: "medium MP4", path: join(FIXTURES, "bench-medium.mp4") },
        { label: "12MP JPEG", path: join(FIXTURES, "bench-photo.jpg") },
    ];

    const results: Record<string, unknown>[] = [];

    for (const file of files) {
        const bytes = new Uint8Array(readFileSync(file.path));
        console.log(`\n=== ${file.label} (${Math.round(bytes.length / 1024)} KB) ===`);

        const readMs = 0;
        const hashMs = await time("contentHash", bytes.length, () => hashAll(bytes));
        const encryptMs = await time("encryptStreamBytes", bytes.length, () => encryptAll(bytes));

        const row = {
            label: file.label,
            bytes: bytes.length,
            hashMs,
            encryptMs,
            preNetworkMs: hashMs + encryptMs,
        };
        results.push(row);

        writeFileSync(LOG_PATH, `${JSON.stringify({
            sessionId: "b43bb4",
            timestamp: Date.now(),
            location: "benchmark-upload-node.ts",
            message: "node-phase-benchmark",
            data: row,
        })}\n`, { flag: "a" });
    }

    console.log("\nNote: excludes video probe, thumbnail, transcode, and network.");
    console.log("Official Ente hashes/encrypts incrementally while streaming; we buffer first.");
};

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
