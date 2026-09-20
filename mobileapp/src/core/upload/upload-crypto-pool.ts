import { ComlinkWorker } from "ente-base/worker/comlink-worker";
import type {
    BytesOrB64,
    EncryptedBlobB64,
    EncryptedBlobBytes,
    EncryptedBoxB64,
    EncryptedFile,
    SodiumStateAddress,
} from "ente-base/crypto/types";

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
 * Dedicated crypto workers for a multi-file upload batch.
 *
 * Matches the official Photos upload manager: one Comlink crypto worker per
 * concurrent upload slot so encrypt/hash run off the UI thread (mobileapp's
 * `ente-base/crypto` shim otherwise runs libsodium on the main thread).
 */
let pool: ComlinkWorker<UploadCryptoWorkerCtor>[] = [];

const createPoolWorker = (): ComlinkWorker<UploadCryptoWorkerCtor> =>
    new ComlinkWorker<UploadCryptoWorkerCtor>(
        "upload-crypto",
        new Worker(
            new URL("../../workers/upload-crypto.worker.ts", import.meta.url),
        ),
    );

/**
 * Create {@link size} dedicated crypto workers for an upload batch.
 */
export const beginUploadCryptoPool = (size: number): void => {
    endUploadCryptoPool();
    const count = Math.max(1, size);
    pool = Array.from({ length: count }, () => createPoolWorker());
};

/**
 * Crypto worker for concurrent upload slot {@link index}.
 */
export const getUploadCryptoWorker = async (
    index: number,
): Promise<UploadCryptoWorker> => {
    const entry = pool[index % Math.max(pool.length, 1)];
    if (!entry) {
        const fallback = createPoolWorker();
        pool.push(fallback);
        return fallback.remote as Promise<UploadCryptoWorker>;
    }
    return entry.remote as Promise<UploadCryptoWorker>;
};

/**
 * Terminate dedicated upload crypto workers.
 */
export const endUploadCryptoPool = (): void => {
    for (const entry of pool) {
        entry.terminate();
    }
    pool = [];
};
