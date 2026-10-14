import type { ServerCiphertext } from "@/core/download";
import { getSessionCacheKey } from "@/lib/cache-key";
import { createLruBlobStore, unwrapBytes, wrapBytes } from "./blob-store";
import type { FileCiphertextRecord } from "./index";

/** Skip caching a single file larger than this. */
const MAX_SINGLE_FILE_BYTES = 200 * 1024 * 1024;

const DISK_BUDGET_BYTES = 400 * 1024 * 1024;

/** Soft cap on total encrypted video bytes kept in IndexedDB. */
const fileCiphertextStore = createLruBlobStore<FileCiphertextRecord>({
    storeName: "fileCiphertexts",
    budgetBytes: DISK_BUDGET_BYTES,
    targetBytes: DISK_BUDGET_BYTES,
    touchMinIntervalMs: 5 * 60 * 1000,
});

/**
 * Read cached full-file ciphertext, unwrap the cacheKey layer, and return the
 * Ente server ciphertext. Touches LRU in memory (batched flush).
 */
export const getFileCiphertext = async (
    fileId: number,
): Promise<ServerCiphertext | undefined> => {
    let cacheKey: string;
    try {
        cacheKey = getSessionCacheKey();
    } catch {
        return undefined;
    }

    const record = await fileCiphertextStore.get(fileId);
    if (!record) {
        return undefined;
    }

    try {
        return {
            encryptedData: await unwrapBytes(record, cacheKey),
            decryptionHeader: record.fileDecryptionHeader,
        };
    } catch {
        await fileCiphertextStore.delete(fileId);
        return undefined;
    }
};

/**
 * Persist Ente server ciphertext wrapped with the session cacheKey, evicting
 * LRU entries to stay under the disk budget.
 */
export const putFileCiphertext = async (
    fileId: number,
    ciphertext: ServerCiphertext,
): Promise<void> => {
    const byteSize = ciphertext.encryptedData.byteLength;
    if (byteSize <= 0 || byteSize > MAX_SINGLE_FILE_BYTES) {
        return;
    }
    try {
        const wrapped = await wrapBytes(
            ciphertext.encryptedData,
            getSessionCacheKey(),
        );
        await fileCiphertextStore.put({
            fileId,
            ...wrapped,
            fileDecryptionHeader: ciphertext.decryptionHeader,
            byteSize,
        });
    } catch {
        // No session key or transient crypto failure — viewer still has network path.
    }
};

export const deleteFileCiphertext = (fileId: number): Promise<void> =>
    fileCiphertextStore.delete(fileId);
