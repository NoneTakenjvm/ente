import { fromB64, toB64 } from "ente-base/crypto";
import { isGalleryScrolling } from "@/lib/gallery-scroll-activity";
import { LruTouchCoalescer } from "./lru-touch";
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
const DISK_BUDGET_BYTES = 400 * 1024 * 1024;

/** Skip scheduling a touch when the row was touched this recently. */
const TOUCH_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Running total of thumbnail store bytes for this page session.
 * Seeded via cursor metadata only — never loading every ciphertext into one
 * JS array (that kept multi-GB heaps).
 */
let cachedDiskBytes: number | undefined;

/** One in-flight size seed so concurrent puts do not each scan the store. */
let seedDiskBytesPromise: Promise<number> | undefined;

/** Serialize eviction so concurrent puts cannot each scan the whole store. */
let evictionChain: Promise<void> = Promise.resolve();

type ThumbnailLruMeta = {
    fileId: number;
    byteSize: number;
    lastAccess: number;
};

const estimateLegacyByteSize = (record: ThumbnailRecord): number => {
    if (typeof record.byteSize === "number" && record.byteSize > 0) {
        return record.byteSize;
    }
    // Base64 expands ~4/3; approximate original ciphertext length.
    return Math.max(1, Math.floor((record.encryptedData.length * 3) / 4));
};

const recordLastAccess = (record: ThumbnailRecord): number =>
    typeof record.lastAccess === "number" ? record.lastAccess : 0;

const thumbnailTouches = new LruTouchCoalescer(async (fileId, lastAccess) => {
    if (!hasOrganizerDB()) {
        return;
    }
    const db = await getOrganizerDB();
    const record = await db.get("thumbnails", fileId);
    if (!record) {
        return;
    }
    await db.put("thumbnails", {
        ...record,
        byteSize: estimateLegacyByteSize(record),
        lastAccess,
    });
});

/**
 * Cursor-scan LRU scalars only. Each ciphertext is eligible for GC after the
 * step that copies byteSize/lastAccess — unlike a full-store materialize,
 * nothing holds all encryptedData strings at once.
 */
const collectThumbnailLruMeta = async (
    db: Awaited<ReturnType<typeof getOrganizerDB>>,
    excludeFileId?: number,
): Promise<{ metas: ThumbnailLruMeta[]; usedBytes: number }> => {
    const metas: ThumbnailLruMeta[] = [];
    let usedBytes = 0;
    const tx = db.transaction("thumbnails", "readonly");
    let cursor = await tx.store.openCursor();
    while (cursor) {
        const record = cursor.value;
        if (excludeFileId === undefined || record.fileId !== excludeFileId) {
            const byteSize = estimateLegacyByteSize(record);
            metas.push({
                fileId: record.fileId,
                byteSize,
                lastAccess: thumbnailTouches.overlay(
                    record.fileId,
                    recordLastAccess(record),
                ),
            });
            usedBytes += byteSize;
        }
        cursor = await cursor.continue();
    }
    await tx.done;
    return { metas, usedBytes };
};

const ensureDiskBytes = async (
    db: Awaited<ReturnType<typeof getOrganizerDB>>,
): Promise<number> => {
    if (cachedDiskBytes !== undefined) {
        return cachedDiskBytes;
    }
    if (!seedDiskBytesPromise) {
        seedDiskBytesPromise = collectThumbnailLruMeta(db)
            .then(({ usedBytes }) => {
                cachedDiskBytes = usedBytes;
                return usedBytes;
            })
            .finally(() => {
                seedDiskBytesPromise = undefined;
            });
    }
    return seedDiskBytesPromise;
};

const adjustDiskBytes = (delta: number): void => {
    if (cachedDiskBytes === undefined) {
        return;
    }
    cachedDiskBytes = Math.max(0, cachedDiskBytes + delta);
};

/**
 * Delete oldest entries until {@link usedBytes} + {@link incomingBytes} fits
 * the disk budget. Only metadata is ranked in memory.
 */
const evictUntilFit = async (
    db: Awaited<ReturnType<typeof getOrganizerDB>>,
    usedBytes: number,
    incomingBytes: number,
    excludeFileId?: number,
): Promise<number> => {
    if (usedBytes + incomingBytes <= DISK_BUDGET_BYTES) {
        return usedBytes;
    }

    const run = async (): Promise<number> => {
        const { metas, usedBytes: scanned } = await collectThumbnailLruMeta(
            db,
            excludeFileId,
        );
        let remaining = scanned;
        if (remaining + incomingBytes > DISK_BUDGET_BYTES) {
            metas.sort((a, b) => a.lastAccess - b.lastAccess);
            const tx = db.transaction("thumbnails", "readwrite");
            for (const entry of metas) {
                if (remaining + incomingBytes <= DISK_BUDGET_BYTES) {
                    break;
                }
                await tx.store.delete(entry.fileId);
                thumbnailTouches.forget(entry.fileId);
                remaining -= entry.byteSize;
            }
            await tx.done;
        }
        // Excludes `excludeFileId`; caller adds the new row size after put.
        cachedDiskBytes = remaining;
        return remaining;
    };

    const next = evictionChain.then(run, run);
    evictionChain = next.then(
        () => undefined,
        () => undefined,
    );
    return next;
};

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

    const now = Date.now();
    const diskAccess = recordLastAccess(record);
    const effectiveAccess = thumbnailTouches.overlay(fileId, diskAccess);
    const needsTouch =
        !isGalleryScrolling() &&
        (!record.byteSize || now - effectiveAccess >= TOUCH_MIN_INTERVAL_MS);
    if (needsTouch) {
        thumbnailTouches.note(fileId, now);
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
        const previous = await db.get("thumbnails", fileId);
        const previousSize = previous ? estimateLegacyByteSize(previous) : 0;
        let usedBytes = (await ensureDiskBytes(db)) - previousSize;

        if (usedBytes + byteSize > DISK_BUDGET_BYTES) {
            usedBytes = await evictUntilFit(db, usedBytes, byteSize, fileId);
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
        thumbnailTouches.forget(fileId);
        cachedDiskBytes = usedBytes + byteSize;
    } catch {
        // Quota or transient IDB failures — gallery still has network path.
        cachedDiskBytes = undefined;
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
        const previous = await db.get("thumbnails", fileId);
        await db.delete("thumbnails", fileId);
        thumbnailTouches.forget(fileId);
        if (previous) {
            adjustDiskBytes(-estimateLegacyByteSize(previous));
        }
    } catch {
        cachedDiskBytes = undefined;
    }
};

/** Flush coalesced LRU lastAccess writes (pagehide / durable flush). */
export const flushThumbnailLruTouches = (): Promise<void> =>
    thumbnailTouches.flush();

/** Test helper — drop the session byte counter (does not touch IndexedDB). */
export const resetThumbnailDiskByteCacheForTests = (): void => {
    cachedDiskBytes = undefined;
    seedDiskBytesPromise = undefined;
};
