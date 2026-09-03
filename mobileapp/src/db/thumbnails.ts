import { fromB64, toB64 } from "ente-base/crypto";
import {
    getOrganizerDB,
    hasOrganizerDB,
    type ThumbnailRecord,
} from "./index";

export interface ServerCiphertext {
    encryptedData: Uint8Array;
    decryptionHeader: string;
}

/** Soft cap on total encrypted thumbnail bytes kept in IndexedDB. */
const DISK_BUDGET_BYTES = 200 * 1024 * 1024;

const estimateLegacyByteSize = (record: ThumbnailRecord): number => {
    if (typeof record.byteSize === "number" && record.byteSize > 0) {
        return record.byteSize;
    }
    // Base64 expands ~4/3; approximate original ciphertext length.
    return Math.max(1, Math.floor((record.encryptedData.length * 3) / 4));
};

const recordLastAccess = (record: ThumbnailRecord): number =>
    typeof record.lastAccess === "number" ? record.lastAccess : 0;

export const hasThumbnailCiphertext = async (
    fileId: number,
): Promise<boolean> => {
    if (!hasOrganizerDB()) {
        return false;
    }
    const db = await getOrganizerDB();
    const record: ThumbnailRecord | undefined = await db.get(
        "thumbnails",
        fileId,
    );
    return record !== undefined;
};

export const getThumbnailCiphertext = async (
    fileId: number,
): Promise<ServerCiphertext | undefined> => {
    if (!hasOrganizerDB()) {
        return undefined;
    }
    const db = await getOrganizerDB();
    const record: ThumbnailRecord | undefined = await db.get(
        "thumbnails",
        fileId,
    );
    if (!record) {
        return undefined;
    }

    const touched: ThumbnailRecord = {
        ...record,
        byteSize: estimateLegacyByteSize(record),
        lastAccess: Date.now(),
    };
    try {
        await db.put("thumbnails", touched);
    } catch {
        // Touch is best-effort — still return the ciphertext.
    }

    return {
        encryptedData: await fromB64(record.encryptedData),
        decryptionHeader: record.decryptionHeader,
    };
};

export const putThumbnailCiphertext = async (
    fileId: number,
    ciphertext: ServerCiphertext,
): Promise<void> => {
    if (!hasOrganizerDB()) {
        return;
    }
    const byteSize = ciphertext.encryptedData.byteLength;
    if (byteSize <= 0) {
        return;
    }

    try {
        const db = await getOrganizerDB();
        const existing = await db.getAll("thumbnails");
        const others = existing.filter((entry) => entry.fileId !== fileId);
        let usedBytes = others.reduce(
            (sum, entry) => sum + estimateLegacyByteSize(entry),
            0,
        );

        if (usedBytes + byteSize > DISK_BUDGET_BYTES) {
            others.sort(
                (a, b) => recordLastAccess(a) - recordLastAccess(b),
            );
            for (const entry of others) {
                if (usedBytes + byteSize <= DISK_BUDGET_BYTES) {
                    break;
                }
                await db.delete("thumbnails", entry.fileId);
                usedBytes -= estimateLegacyByteSize(entry);
            }
        }

        if (usedBytes + byteSize > DISK_BUDGET_BYTES) {
            return;
        }

        await db.put("thumbnails", {
            fileId,
            encryptedData: await toB64(ciphertext.encryptedData),
            decryptionHeader: ciphertext.decryptionHeader,
            byteSize,
            lastAccess: Date.now(),
        });
    } catch {
        // Quota or transient IDB failures — gallery still has network path.
    }
};

export const deleteThumbnailCiphertext = async (
    fileId: number,
): Promise<void> => {
    if (!hasOrganizerDB()) {
        return;
    }
    try {
        const db = await getOrganizerDB();
        await db.delete("thumbnails", fileId);
    } catch {
        // ignore
    }
};
