import { decryptBlobBytes, encryptBlobBytes, toB64 } from "ente-base/crypto";
import type { ServerCiphertext } from "@/core/download";
import { getSessionCacheKey } from "@/lib/cache-key";
import {
    getOrganizerDB,
    hasOrganizerDB,
    type FileCiphertextRecord,
} from "./index";

/** Soft cap on total encrypted video bytes kept in IndexedDB. */
const DISK_BUDGET_BYTES = 400 * 1024 * 1024;

/** Skip caching a single file larger than this. */
const MAX_SINGLE_FILE_BYTES = 200 * 1024 * 1024;

const isWrappedRecord = (
    record: FileCiphertextRecord,
): record is FileCiphertextRecord & { fileDecryptionHeader: string } =>
    typeof record.fileDecryptionHeader === "string" &&
    record.fileDecryptionHeader.length > 0;

/**
 * Read cached full-file ciphertext, unwrap the cacheKey layer, and return the
 * Ente server ciphertext. Touches LRU on hit. Drops legacy unwrapped rows.
 */
export const getFileCiphertext = async (
    fileId: number,
): Promise<ServerCiphertext | undefined> => {
    if (!hasOrganizerDB()) {
        return undefined;
    }
    let cacheKey: string;
    try {
        cacheKey = getSessionCacheKey();
    } catch {
        return undefined;
    }

    const db = await getOrganizerDB();
    const record: FileCiphertextRecord | undefined = await db.get(
        "fileCiphertexts",
        fileId,
    );
    if (!record) {
        return undefined;
    }
    if (!isWrappedRecord(record)) {
        await db.delete("fileCiphertexts", fileId);
        return undefined;
    }

    try {
        const serverBytes = await decryptBlobBytes(
            {
                encryptedData: new Uint8Array(record.encryptedData),
                decryptionHeader: record.decryptionHeader,
            },
            cacheKey,
        );
        const touched: FileCiphertextRecord = {
            ...record,
            lastAccess: Date.now(),
        };
        await db.put("fileCiphertexts", touched);
        return {
            encryptedData: serverBytes,
            decryptionHeader: record.fileDecryptionHeader,
        };
    } catch {
        await db.delete("fileCiphertexts", fileId);
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
    if (!hasOrganizerDB()) {
        return;
    }
    let cacheKey: string;
    try {
        cacheKey = getSessionCacheKey();
    } catch {
        return;
    }

    const byteSize = ciphertext.encryptedData.byteLength;
    if (byteSize <= 0 || byteSize > MAX_SINGLE_FILE_BYTES) {
        return;
    }

    try {
        const wrapped = await encryptBlobBytes(
            ciphertext.encryptedData,
            cacheKey,
        );
        const db = await getOrganizerDB();
        const existing = await db.getAll("fileCiphertexts");
        const others = existing.filter((entry) => entry.fileId !== fileId);
        let usedBytes = others.reduce((sum, entry) => sum + entry.byteSize, 0);

        if (usedBytes + byteSize > DISK_BUDGET_BYTES) {
            others.sort((a, b) => a.lastAccess - b.lastAccess);
            for (const entry of others) {
                if (usedBytes + byteSize <= DISK_BUDGET_BYTES) {
                    break;
                }
                await db.delete("fileCiphertexts", entry.fileId);
                usedBytes -= entry.byteSize;
            }
        }

        if (usedBytes + byteSize > DISK_BUDGET_BYTES) {
            return;
        }

        const record: FileCiphertextRecord = {
            fileId,
            encryptedData: wrapped.encryptedData.slice().buffer,
            decryptionHeader: await toB64(wrapped.decryptionHeader),
            fileDecryptionHeader: ciphertext.decryptionHeader,
            byteSize,
            lastAccess: Date.now(),
        };
        await db.put("fileCiphertexts", record);
    } catch {
        // Quota or transient IDB/crypto failures — viewer still has network path.
    }
};

export const deleteFileCiphertext = async (fileId: number): Promise<void> => {
    if (!hasOrganizerDB()) {
        return;
    }
    try {
        const db = await getOrganizerDB();
        await db.delete("fileCiphertexts", fileId);
    } catch {
        // ignore
    }
};
