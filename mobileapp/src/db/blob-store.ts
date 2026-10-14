import {
    decryptBlobBytes,
    encryptBlobBytes,
    toB64,
} from "ente-base/crypto";
import type { IDBPDatabase } from "idb";
import { registerFlush } from "@/lib/session-lifecycle";
import { getOrganizerDB, hasOrganizerDB } from "./index";

/** Fields the LRU store needs on every row; rows are keyed by `fileId`. */
export interface LruBlobRecord {
    fileId: number;
    /** Ciphertext byte length, counted against the budget. */
    byteSize: number;
    /** LRU touch time (epoch ms). */
    lastAccess: number;
}

/** A blob encrypted with the session cacheKey, in its at-rest record shape. */
export interface WrappedBytes {
    encryptedData: ArrayBuffer;
    /** Base64 stream header for the cacheKey layer. */
    decryptionHeader: string;
}

export interface LruBlobStoreOptions {
    storeName: "thumbnails" | "fileCiphertexts";
    /** Soft cap on total {@link LruBlobRecord.byteSize} kept in the store. */
    budgetBytes: number;
    /**
     * Eviction frees space down to this level, not just enough for one row, so
     * bulk puts scan the store once per `budgetBytes - targetBytes` instead of
     * on every put.
     */
    targetBytes: number;
    /** Skip scheduling a touch when the row was touched this recently. */
    touchMinIntervalMs: number;
    /** Return true to skip touching on read (e.g. while scrolling). */
    suppressTouch?: () => boolean;
}

export interface LruBlobStore<R extends LruBlobRecord> {
    has(fileId: number): Promise<boolean>;
    /** Read a row and schedule a batched LRU touch. */
    get(fileId: number): Promise<R | undefined>;
    /**
     * Insert or replace a row, evicting least-recently-used rows to stay under
     * budget. Returns false when the row could not be stored.
     */
    put(record: Omit<R, "lastAccess">): Promise<boolean>;
    delete(fileId: number): Promise<void>;
    /** Flush coalesced LRU lastAccess writes (pagehide / durable flush). */
    flushTouches(): Promise<void>;
    clear(): Promise<void>;
}

/** Flush pending touches after this many distinct file ids. */
const TOUCH_FLUSH_EVERY = 32;

/**
 * Encrypt bytes with the session cacheKey into the record fields shared by
 * the encrypted blob stores.
 */
export const wrapBytes = async (
    bytes: Uint8Array,
    cacheKey: string,
): Promise<WrappedBytes> => {
    const wrapped = await encryptBlobBytes(bytes, cacheKey);
    return {
        encryptedData: wrapped.encryptedData.slice().buffer,
        decryptionHeader: await toB64(wrapped.decryptionHeader),
    };
};

/** Inverse of {@link wrapBytes}. Throws when the cacheKey does not match. */
export const unwrapBytes = (
    record: WrappedBytes,
    cacheKey: string,
): Promise<Uint8Array> =>
    decryptBlobBytes(
        {
            encryptedData: new Uint8Array(record.encryptedData),
            decryptionHeader: record.decryptionHeader,
        },
        cacheKey,
    );

/**
 * An IndexedDB store of large encrypted rows capped by total bytes, evicting
 * least-recently-used rows first.
 *
 * [Note: LRU eviction never loads ciphertexts together]
 *
 * Rows hold multi-MB buffers. Eviction ranks rows by scanning a cursor and
 * copying only `fileId / byteSize / lastAccess`; it must never `getAll` the
 * store. LRU `lastAccess` updates are coalesced in memory and flushed in
 * batches, since rewriting a large row on every cache hit amplifies IDB
 * traffic.
 */
export const createLruBlobStore = <R extends LruBlobRecord>(
    options: LruBlobStoreOptions,
): LruBlobStore<R> => {
    const { storeName, budgetBytes, targetBytes } = options;

    /** Running total of store bytes, seeded by one cursor scan. */
    let cachedDiskBytes: number | undefined;
    /** The connection `cachedDiskBytes` was seeded from (user switch resets). */
    let cachedFor: IDBPDatabase | undefined;
    let seedPromise: Promise<number> | undefined;
    /** Serialize eviction so concurrent puts cannot each scan the store. */
    let evictionChain: Promise<void> = Promise.resolve();

    const pendingTouches = new Map<number, number>();
    let touchFlushChain: Promise<void> = Promise.resolve();

    const openDB = async (): Promise<IDBPDatabase> => {
        const db = (await getOrganizerDB()) as unknown as IDBPDatabase;
        if (cachedFor !== db) {
            cachedFor = db;
            cachedDiskBytes = undefined;
            seedPromise = undefined;
        }
        return db;
    };

    const writeTouches = async (
        batch: ReadonlyMap<number, number>,
    ): Promise<void> => {
        if (!hasOrganizerDB()) {
            return;
        }
        const db = await openDB();
        const tx = db.transaction(storeName, "readwrite");
        for (const [fileId, lastAccess] of batch) {
            const record = (await tx.store.get(fileId)) as R | undefined;
            if (record) {
                await tx.store.put({ ...record, lastAccess });
            }
        }
        await tx.done;
    };

    const flushTouches = (): Promise<void> => {
        if (pendingTouches.size === 0) {
            return touchFlushChain;
        }
        const batch = new Map(pendingTouches);
        pendingTouches.clear();
        touchFlushChain = touchFlushChain
            .catch(() => undefined)
            .then(async () => {
                try {
                    await writeTouches(batch);
                } catch {
                    // Re-queue so a later flush can retry.
                    for (const [fileId, lastAccess] of batch) {
                        if (!pendingTouches.has(fileId)) {
                            pendingTouches.set(fileId, lastAccess);
                        }
                    }
                }
            });
        return touchFlushChain;
    };
    registerFlush(flushTouches);

    const noteTouch = (fileId: number, lastAccess: number): void => {
        pendingTouches.set(fileId, lastAccess);
        if (pendingTouches.size >= TOUCH_FLUSH_EVERY) {
            void flushTouches();
        }
    };

    /**
     * Cursor-scan LRU scalars only, preferring pending touch times. Each
     * ciphertext is eligible for GC after the step that copies its scalars.
     */
    const scanLruMeta = async (
        db: IDBPDatabase,
        excludeFileId?: number,
    ): Promise<{ metas: LruBlobRecord[]; usedBytes: number }> => {
        const metas: LruBlobRecord[] = [];
        let usedBytes = 0;
        const tx = db.transaction(storeName, "readonly");
        let cursor = await tx.store.openCursor();
        while (cursor) {
            const record = cursor.value as R;
            if (record.fileId !== excludeFileId) {
                metas.push({
                    fileId: record.fileId,
                    byteSize: record.byteSize,
                    lastAccess:
                        pendingTouches.get(record.fileId) ?? record.lastAccess,
                });
                usedBytes += record.byteSize;
            }
            cursor = await cursor.continue();
        }
        await tx.done;
        return { metas, usedBytes };
    };

    const ensureDiskBytes = (db: IDBPDatabase): Promise<number> => {
        if (cachedDiskBytes !== undefined) {
            return Promise.resolve(cachedDiskBytes);
        }
        // One in-flight seed so concurrent puts do not each scan the store.
        seedPromise ??= scanLruMeta(db)
            .then(({ usedBytes }) => {
                cachedDiskBytes = usedBytes;
                return usedBytes;
            })
            .finally(() => {
                seedPromise = undefined;
            });
        return seedPromise;
    };

    const adjustDiskBytes = (delta: number): void => {
        if (cachedDiskBytes !== undefined) {
            cachedDiskBytes = Math.max(0, cachedDiskBytes + delta);
        }
    };

    /**
     * Make room for `incomingBytes`: when the store would exceed the budget,
     * delete oldest rows until it fits `targetBytes`. Returns the bytes used
     * excluding `excludeFileId`, whose current row is `excludedBytes` long.
     */
    const evictUntilFit = (
        db: IDBPDatabase,
        excludedBytes: number,
        incomingBytes: number,
        excludeFileId: number,
    ): Promise<number> => {
        const run = async (): Promise<number> => {
            // Concurrent puts queue here together; the first eviction usually
            // makes room for the rest without another scan.
            if (cachedDiskBytes !== undefined) {
                const usedBytes = cachedDiskBytes - excludedBytes;
                if (usedBytes + incomingBytes <= budgetBytes) {
                    return usedBytes;
                }
            }
            const { metas, usedBytes: scanned } = await scanLruMeta(
                db,
                excludeFileId,
            );
            let remaining = scanned;
            if (remaining + incomingBytes > budgetBytes) {
                metas.sort((a, b) => a.lastAccess - b.lastAccess);
                const tx = db.transaction(storeName, "readwrite");
                for (const entry of metas) {
                    if (remaining + incomingBytes <= targetBytes) {
                        break;
                    }
                    await tx.store.delete(entry.fileId);
                    pendingTouches.delete(entry.fileId);
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

    return {
        async has(fileId) {
            if (!hasOrganizerDB()) {
                return false;
            }
            const db = await openDB();
            return (await db.getKey(storeName, fileId)) !== undefined;
        },

        async get(fileId) {
            if (!hasOrganizerDB()) {
                return undefined;
            }
            const db = await openDB();
            const record = (await db.get(storeName, fileId)) as R | undefined;
            if (!record) {
                return undefined;
            }
            const now = Date.now();
            const lastAccess =
                pendingTouches.get(fileId) ?? record.lastAccess;
            if (
                !options.suppressTouch?.() &&
                now - lastAccess >= options.touchMinIntervalMs
            ) {
                noteTouch(fileId, now);
            }
            return record;
        },

        async put(record) {
            if (!hasOrganizerDB() || record.byteSize <= 0) {
                return false;
            }
            const { fileId, byteSize } = record;
            try {
                const db = await openDB();
                const previous = (await db.get(storeName, fileId)) as
                    | R |
                    undefined;
                const previousSize = previous?.byteSize ?? 0;
                let usedBytes = (await ensureDiskBytes(db)) - previousSize;

                if (usedBytes + byteSize > budgetBytes) {
                    usedBytes = await evictUntilFit(
                        db,
                        previousSize,
                        byteSize,
                        fileId,
                    );
                }
                if (usedBytes + byteSize > budgetBytes) {
                    return false;
                }

                await db.put(storeName, { ...record, lastAccess: Date.now() });
                pendingTouches.delete(fileId);
                cachedDiskBytes = usedBytes + byteSize;
                return true;
            } catch {
                // Quota or transient IDB failures — callers have a network path.
                cachedDiskBytes = undefined;
                return false;
            }
        },

        async delete(fileId) {
            if (!hasOrganizerDB()) {
                return;
            }
            try {
                const db = await openDB();
                const previous = (await db.get(storeName, fileId)) as
                    | R |
                    undefined;
                await db.delete(storeName, fileId);
                pendingTouches.delete(fileId);
                if (previous) {
                    adjustDiskBytes(-previous.byteSize);
                }
            } catch {
                cachedDiskBytes = undefined;
            }
        },

        flushTouches,

        async clear() {
            if (!hasOrganizerDB()) {
                return;
            }
            try {
                const db = await openDB();
                await db.clear(storeName);
                pendingTouches.clear();
                cachedDiskBytes = 0;
            } catch {
                cachedDiskBytes = undefined;
            }
        },
    };
};
