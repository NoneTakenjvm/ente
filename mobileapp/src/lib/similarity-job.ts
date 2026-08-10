import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import type { PhashEntry } from "@/lib/crop-match";
import {
    loadEncryptedPhashIndex,
    saveEncryptedPhashIndex,
    type PersistedPhashEntry,
    type PersistedPhashIndex,
} from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";
import {
    getDecryptedThumbnailBytes,
    isThumbnailCachedLocally,
} from "@/lib/thumbnail-bytes";
import type {
    CropCheckResult,
    PhashWorkerRequest,
    PhashWorkerResponse,
} from "@/workers/phash-worker-types";

export interface PhashJobOptions {
    files: EnteFile[];
    entries: Map<number, PhashEntry>;
    onProgress?: (current: number, total: number) => void;
    shouldPause?: () => boolean;
    signal?: AbortSignal;
}

const emptyIndex = (): PersistedPhashIndex => ({
    version: 3,
    entries: {},
});

const indexFromMap = (entries: Map<number, PhashEntry>): PersistedPhashIndex => ({
    version: 3,
    entries: Object.fromEntries(entries.entries()),
});

const persistIndex = async (entries: Map<number, PhashEntry>): Promise<void> => {
    await saveEncryptedPhashIndex(
        indexFromMap(entries),
        getSessionCacheKey(),
    );
};

const phashWorkerCount = (): number => {
    if (typeof navigator === "undefined") {
        return 4;
    }
    return Math.min(8, Math.max(2, navigator.hardwareConcurrency ?? 4));
};

let workers: Worker[] | undefined;
let workerRoundRobin = 0;
let requestCounter = 0;

const getPhashWorkers = (): Worker[] => {
    if (!workers) {
        workers = Array.from({ length: phashWorkerCount() }, () =>
            new Worker(new URL("../workers/phash.worker.ts", import.meta.url)));
    }
    return workers;
};

const hashBytesInWorker = (
    fileId: number,
    bytes: Uint8Array,
): Promise<PhashEntry> =>
    new Promise((resolve, reject) => {
        const phashWorker = nextWorker();
        const requestId = ++requestCounter;

        const handleMessage = (event: MessageEvent<PhashWorkerResponse>): void => {
            if (event.data.id !== requestId) {
                return;
            }
            phashWorker.removeEventListener("message", handleMessage);
            if (event.data.error || !event.data.hashes || !event.data.color || !event.data.grid) {
                reject(new Error(event.data.error ?? "Hash failed"));
                return;
            }
            resolve({
                hashes: event.data.hashes,
                color: event.data.color,
                grid: event.data.grid,
            });
        };

        phashWorker.addEventListener("message", handleMessage);
        const request: PhashWorkerRequest = {
            kind: "hash",
            id: requestId,
            fileId,
            bytes: bytes.slice(),
        };
        phashWorker.postMessage(request, [request.bytes.buffer]);
    });

/** Pick the next worker round-robin from the shared pool. */
const nextWorker = (): Worker => {
    const pool = getPhashWorkers();
    const worker = pool[workerRoundRobin % pool.length]!;
    workerRoundRobin += 1;
    return worker;
};

/**
 * Verify whether two images could be the same photo under a crop, entirely on
 * the worker thread. Cheap to call per candidate pair; unions the verdicts
 * back on the caller.
 */
export const checkCropMatchInWorkers = (
    aColor: string,
    aGrid: string,
    bColor: string,
    bGrid: string,
): Promise<boolean> =>
    new Promise((resolve) => {
        const worker = nextWorker();
        const requestId = ++requestCounter;

        const handleMessage = (event: MessageEvent<CropCheckResult>): void => {
            if (event.data.id !== requestId) {
                return;
            }
            worker.removeEventListener("message", handleMessage);
            if (event.data.error) {
                resolve(false);
                return;
            }
            resolve(event.data.match);
        };

        worker.addEventListener("message", handleMessage);
        worker.postMessage({
            kind: "crop-check",
            id: requestId,
            aColor,
            aGrid,
            bColor,
            bGrid,
        });
    });

export const imageFilesForPhash = (
    files: EnteFile[],
    userId: number,
): EnteFile[] =>
    files.filter(
        (file) =>
            file.ownerID === userId &&
            file.metadata.fileType === FileType.image,
    );

/** Normalize a legacy (v1/v2) or current (v3) persisted value to a full {@link PhashEntry}. */
const toPhashEntry = (
    value: PersistedPhashEntry | string | string[],
): PhashEntry => {
    if (typeof value === "string") {
        return { hashes: [value] };
    }
    if (Array.isArray(value)) {
        return { hashes: value };
    }
    return {
        hashes: Array.isArray(value.hashes) ? value.hashes : [value.hashes],
        color: value.color,
        grid: value.grid,
    };
};

export const hydratePhashIndex = async (): Promise<Map<number, PhashEntry>> => {
    const persisted = await loadEncryptedPhashIndex(getSessionCacheKey());
    if (!persisted) {
        return new Map();
    }
    const entries = new Map<number, PhashEntry>();
    for (const [fileId, value] of Object.entries(persisted.entries)) {
        entries.set(Number(fileId), toPhashEntry(value));
    }
    return entries;
};

export const clearPersistedPhashIndex = async (): Promise<void> => {
    await saveEncryptedPhashIndex(emptyIndex(), getSessionCacheKey());
};

/**
 * Drop a single file from the persisted phash index (e.g. after thumbnail change).
 */
export const removePhashEntry = async (fileId: number): Promise<void> => {
    const persisted = await loadEncryptedPhashIndex(getSessionCacheKey());
    if (!persisted || !(String(fileId) in persisted.entries)) {
        return;
    }
    const nextEntries = { ...persisted.entries };
    delete nextEntries[fileId];
    await saveEncryptedPhashIndex(
        { version: 3, entries: nextEntries },
        getSessionCacheKey(),
    );
};

/** Write the index every N hashes so progress survives interruption. */
const persistEvery = 64;
const cacheCheckConcurrency = 32;
const cachedThumbnailConcurrency = 32;
const networkThumbnailConcurrency = 8;

const runWithConcurrency = async <T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>,
): Promise<void> => {
    let index = 0;
    const runners = Array.from(
        { length: Math.min(limit, items.length) },
        async (): Promise<void> => {
            while (index < items.length) {
                const current = items[index];
                index += 1;
                await worker(current);
            }
        },
    );
    await Promise.all(runners);
};

const waitIfPaused = async (
    shouldPause?: () => boolean,
    signal?: AbortSignal,
): Promise<boolean> => {
    while (shouldPause?.()) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (signal?.aborted) {
            return true;
        }
    }
    return signal?.aborted ?? false;
};

/**
 * Compute dHash + crop signals for image files missing from the index; persist
 * incrementally.
 */
export const runPhashJob = async (
    options: PhashJobOptions,
): Promise<Map<number, PhashEntry>> => {
    const candidates = options.files
        .filter((file) => !options.entries.has(file.id))
        .sort((a, b) => a.id - b.id);

    const total = candidates.length;
    let completed = 0;
    let hashesSincePersist = 0;
    let persistChain = Promise.resolve();
    const entries = new Map(options.entries);

    if (total === 0) {
        return entries;
    }

    const cachedFiles: EnteFile[] = [];
    const networkFiles: EnteFile[] = [];
    await runWithConcurrency(candidates, cacheCheckConcurrency, async (file) => {
        const cached = await isThumbnailCachedLocally(file.id);
        if (cached) {
            cachedFiles.push(file);
        } else {
            networkFiles.push(file);
        }
    });

    const noteHashed = async (): Promise<void> => {
        hashesSincePersist += 1;
        if (hashesSincePersist < persistEvery) {
            return;
        }
        hashesSincePersist = 0;
        persistChain = persistChain.then(() => persistIndex(entries));
        await persistChain;
    };

    const processOne = async (file: EnteFile): Promise<void> => {
        if (options.signal?.aborted) {
            return;
        }
        if (await waitIfPaused(options.shouldPause, options.signal)) {
            return;
        }

        const bytes = await getDecryptedThumbnailBytes(file);
        if (bytes) {
            try {
                const entry = await hashBytesInWorker(file.id, bytes);
                entries.set(file.id, entry);
                await noteHashed();
            } catch {
                // Skip files we cannot hash.
            }
        }

        completed += 1;
        options.onProgress?.(completed, total);
    };

    await Promise.all([
        runWithConcurrency(cachedFiles, cachedThumbnailConcurrency, processOne),
        runWithConcurrency(networkFiles, networkThumbnailConcurrency, processOne),
    ]);

    await persistIndex(entries);
    return entries;
};

export const terminatePhashWorker = (): void => {
    workers?.forEach((worker) => {
        worker.terminate();
    });
    workers = undefined;
    workerRoundRobin = 0;
};
