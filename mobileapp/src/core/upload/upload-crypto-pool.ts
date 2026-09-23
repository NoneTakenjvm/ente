import { ComlinkWorker } from "ente-base/worker/comlink-worker";
import * as libsodium from "ente-base/crypto/libsodium";
import type {
    BytesOrB64,
    EncryptedBlobB64,
    EncryptedBlobBytes,
    EncryptedBoxB64,
    EncryptedFile,
    SodiumStateAddress,
} from "ente-base/crypto/types";
import { withTimeout } from "@/lib/with-timeout";

/**
 * Methods used by batch uploads on a dedicated crypto worker.
 *
 * Kept as an explicit interface so we do not import the worker module on the
 * main thread (that would run `expose()` outside a Worker).
 */
export interface UploadCryptoWorker {
    toB64: (bytes: Uint8Array) => Promise<string>;
    generateBlobOrStreamKey: () => Promise<string>;
    encryptBox: (data: BytesOrB64, key: BytesOrB64) => Promise<EncryptedBoxB64>;
    encryptBlobBytes: (
        data: Uint8Array,
        key: BytesOrB64,
    ) => Promise<EncryptedBlobBytes>;
    encryptMetadataJSON: (
        jsonValue: unknown,
        key: BytesOrB64,
    ) => Promise<EncryptedBlobB64>;
    encryptStreamBytes: (
        data: Uint8Array,
        key: BytesOrB64,
    ) => Promise<EncryptedFile>;
    chunkHashInit: () => Promise<SodiumStateAddress>;
    chunkHashUpdate: (
        state: SodiumStateAddress,
        data: Uint8Array,
    ) => Promise<void>;
    chunkHashFinal: (state: SodiumStateAddress) => Promise<string>;
}

/** Constructor shape expected by {@link ComlinkWorker}. */
type UploadCryptoWorkerCtor = new () => UploadCryptoWorker;

/**
 * Cap how long we wait for Comlink + libsodium WASM inside a Worker.
 * iOS Safari can leave `ComlinkWorker.remote` pending forever (no reject).
 */
const CRYPTO_WORKER_READY_MS = 4_000;

/**
 * Dedicated crypto workers for a multi-file upload batch.
 *
 * Matches the official Photos upload manager when Workers work. On iOS Safari
 * (and any Worker init failure), callers fall back to main-thread libsodium —
 * the same path mobileapp's `ente-base/crypto` shim already uses elsewhere.
 */
let pool: ComlinkWorker<UploadCryptoWorkerCtor>[] = [];
let useWorkers = false;

/** True when dedicated upload crypto Workers are unreliable (iOS / iPadOS). */
const prefersMainThreadCrypto = (): boolean => {
    if (typeof navigator === "undefined") {
        return true;
    }
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua)) {
        return true;
    }
    // iPadOS desktop-class UA.
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
};

/**
 * Main-thread libsodium adapter with the same shape as the Worker API.
 */
const mainThreadCrypto = (): UploadCryptoWorker => ({
    toB64: libsodium.toB64,
    generateBlobOrStreamKey: libsodium.generateBlobOrStreamKey,
    encryptBox: libsodium.encryptBox,
    encryptBlobBytes: libsodium.encryptBlobBytes,
    encryptMetadataJSON: libsodium.encryptMetadataJSON,
    encryptStreamBytes: libsodium.encryptStreamBytes,
    chunkHashInit: libsodium.chunkHashInit,
    chunkHashUpdate: libsodium.chunkHashUpdate,
    chunkHashFinal: libsodium.chunkHashFinal,
});

const createPoolWorker = (): ComlinkWorker<UploadCryptoWorkerCtor> =>
    new ComlinkWorker<UploadCryptoWorkerCtor>(
        "upload-crypto",
        new Worker(
            new URL("../../workers/upload-crypto.worker.ts", import.meta.url),
        ),
    );

/**
 * Create {@link size} dedicated crypto workers for an upload batch.
 * No-ops on iOS — Workers + Comlink have hung uploads at 0/x there.
 */
export const beginUploadCryptoPool = (size: number): void => {
    endUploadCryptoPool();
    if (prefersMainThreadCrypto()) {
        useWorkers = false;
        return;
    }
    useWorkers = true;
    const count = Math.max(1, size);
    pool = Array.from({ length: count }, () => createPoolWorker());
};

/**
 * Crypto for concurrent upload slot {@link index}.
 *
 * Returns a Worker when ready within {@link CRYPTO_WORKER_READY_MS}; otherwise
 * main-thread libsodium so uploads never stall waiting on Comlink.
 */
export const getUploadCryptoWorker = async (
    index: number,
): Promise<UploadCryptoWorker> => {
    if (!useWorkers || pool.length === 0) {
        return mainThreadCrypto();
    }

    const entry = pool[index % pool.length];
    if (!entry) {
        return mainThreadCrypto();
    }

    try {
        return await withTimeout(
            entry.remote as Promise<UploadCryptoWorker>,
            CRYPTO_WORKER_READY_MS,
            "Upload crypto worker timed out",
        );
    } catch {
        try {
            entry.terminate();
        } catch {
            // Ignore terminate races.
        }
        return mainThreadCrypto();
    }
};

/**
 * Terminate dedicated upload crypto workers.
 */
export const endUploadCryptoPool = (): void => {
    for (const entry of pool) {
        entry.terminate();
    }
    pool = [];
    useWorkers = false;
};
