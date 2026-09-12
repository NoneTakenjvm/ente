import { decryptBlobBytes, encryptBlobBytes, toB64 } from "ente-base/crypto";
import type { ServerCiphertext } from "@/core/download";
import { getSessionCacheKey } from "@/lib/cache-key";
import { LruTouchCoalescer } from "./lru-touch";
import {
    getOrganizerDB,
    hasOrganizerDB,
    type FileCiphertextRecord,
} from "./index";

/** Soft cap on total encrypted video bytes kept in IndexedDB. */
const DISK_BUDGET_BYTES = 400 * 1024 * 1024;

/** Skip caching a single file larger than this. */
const MAX_SINGLE_FILE_BYTES = 200 * 1024 * 1024;

/** Skip scheduling a touch when the row was touched this recently. */
const TOUCH_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Serialize eviction so concurrent puts cannot each scan the whole store. */
let evictionChain: Promise<void> = Promise.resolve();

type FileCiphertextLruMeta = {
    fileId: number;
    byteSize: number;
    lastAccess: number;
};

const isWrappedRecord = (
    record: FileCiphertextRecord,
): record is FileCiphertextRecord & { fileDecryptionHeader: string } =>
    typeof record.fileDecryptionHeader === "string" &&
    record.fileDecryptionHeader.length > 0;

const fileCiphertextTouches = new LruTouchCoalescer(
    async (fileId, lastAccess) => {
        if (!hasOrganizerDB()) {
            return;
        }
        const db = await getOrganizerDB();
        const record = await db.get("fileCiphertexts", fileId);
        if (!record || !isWrappedRecord(record)) {
            return;
        }
        await db.put("fileCiphertexts", {
            ...record,
            lastAccess,
        });
    },
);

/**
 * Cursor-scan LRU scalars only — never materializing every ciphertext buffer.
 */
const collectFileCiphertextLruMeta = async (
    db: Awaited<ReturnType<typeof getOrganizerDB>>,
    excludeFileId?: number,
): Promise<{ metas: FileCiphertextLruMeta[]; usedBytes: number }> => {
    const metas: FileCiphertextLruMeta[] = [];
    let usedBytes = 0;
    const tx = db.transaction("fileCiphertexts", "readonly");
    let cursor = await tx.store.openCursor();
    while (cursor) {
        const record = cursor.value;
        if (excludeFileId === undefined || record.fileId !== excludeFileId) {
            metas.push({
                fileId: record.fileId,
                byteSize: record.byteSize,
                lastAccess: fileCiphertextTouches.overlay(
                    record.fileId,
                    record.lastAccess,
                ),
            });
            usedBytes += record.byteSize;
        }
        cursor = await cursor.continue();
    }
    await tx.done;
    return { metas, usedBytes };
};

const evictUntilFit = async (
    db: Awaited<ReturnType<typeof getOrganizerDB>>,
    usedBytes: number,
    incomingBytes: number,
    excludeFileId: number,
): Promise<number> => {
    if (usedBytes + incomingBytes <= DISK_BUDGET_BYTES) {
        return usedBytes;
    }

    const run = async (): Promise<number> => {
        const { metas, usedBytes: scanned } = await collectFileCiphertextLruMeta(
            db,
            excludeFileId,
        );
        let remaining = scanned;
        if (remaining + incomingBytes > DISK_BUDGET_BYTES) {
            metas.sort((a, b) => a.lastAccess - b.lastAccess);
            const tx = db.transaction("fileCiphertexts", "readwrite");
            for (const entry of metas) {
                if (remaining + incomingBytes <= DISK_BUDGET_BYTES) {
                    break;
                }
                await tx.store.delete(entry.fileId);
                fileCiphertextTouches.forget(entry.fileId);
                remaining -= entry.byteSize;
            }
            await tx.done;
        }
        return remaining;
    };

    const next = evictionChain.then(run, run);
    evictionChain = next.then(
        () => undefined,
        () => undefined,
    );
    return next;
};

/**
 * Read cached full-file ciphertext, unwrap the cacheKey layer, and return the
 * Ente server ciphertext. Touches LRU in memory (batched flush). Drops legacy
 * unwrapped rows.
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
        const now = Date.now();
        const effectiveAccess = fileCiphertextTouches.overlay(
            fileId,
            record.lastAccess,
        );
        if (now - effectiveAccess >= TOUCH_MIN_INTERVAL_MS) {
            fileCiphertextTouches.note(fileId, now);
        }
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
        const { usedBytes: othersBytes } = await collectFileCiphertextLruMeta(
            db,
            fileId,
        );
        let usedBytes = othersBytes;

        if (usedBytes + byteSize > DISK_BUDGET_BYTES) {
            usedBytes = await evictUntilFit(db, usedBytes, byteSize, fileId);
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
        fileCiphertextTouches.forget(fileId);
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
        fileCiphertextTouches.forget(fileId);
    } catch {
        // ignore
    }
};

/** Flush coalesced LRU lastAccess writes (pagehide / durable flush). */
export const flushFileCiphertextLruTouches = (): Promise<void> =>
    fileCiphertextTouches.flush();
