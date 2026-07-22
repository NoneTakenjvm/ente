import type { ServerCiphertext } from "@/core/download";
import {
    getOrganizerDB,
    hasOrganizerDB,
    type FileCiphertextRecord,
} from "./index";

/** Soft cap on total encrypted video bytes kept in IndexedDB. */
const DISK_BUDGET_BYTES = 400 * 1024 * 1024;

/** Skip caching a single file larger than this. */
const MAX_SINGLE_FILE_BYTES = 200 * 1024 * 1024;

/**
 * Read cached server ciphertext for a full file, if present.
 * Touches {@link FileCiphertextRecord.lastAccess} on hit.
 */
export const getFileCiphertext = async (
    fileId: number,
): Promise<ServerCiphertext | undefined> => {
    if (!hasOrganizerDB()) {
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
    const touched: FileCiphertextRecord = {
        ...record,
        lastAccess: Date.now(),
    };
    await db.put("fileCiphertexts", touched);
    return {
        encryptedData: new Uint8Array(record.encryptedData),
        decryptionHeader: record.decryptionHeader,
    };
};

/**
 * Persist server ciphertext for a full file, evicting LRU entries to stay
 * under the disk budget. No-ops on quota errors or oversized files.
 */
export const putFileCiphertext = async (
    fileId: number,
    ciphertext: ServerCiphertext,
): Promise<void> => {
    if (!hasOrganizerDB()) {
        return;
    }
    const byteSize = ciphertext.encryptedData.byteLength;
    if (byteSize <= 0 || byteSize > MAX_SINGLE_FILE_BYTES) {
        return;
    }

    try {
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
            encryptedData: ciphertext.encryptedData.slice().buffer,
            decryptionHeader: ciphertext.decryptionHeader,
            byteSize,
            lastAccess: Date.now(),
        };
        await db.put("fileCiphertexts", record);
    } catch {
        // Quota or transient IDB failures — viewer still has network path.
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
