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
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import { waitWhileGalleryScrolling } from "@/lib/gallery-scroll-activity";
import type {
    Stage1Cluster,
    Stage1FileEdge,
    Stage1Item,
    Stage1ProgressUpdate,
} from "@/lib/similarity-stage1-core";
import type {
    CropCheckBatchMessage,
    CropCheckBatchResult,
    PhashWorkerOutbound,
    PhashWorkerRequest,
    PhashWorkerResponse,
    Stage1Message,
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

        const handleMessage = (event: MessageEvent<PhashWorkerOutbound>): void => {
            const data = event.data;
            if (!("fileId" in data) || data.id !== requestId) {
                return;
            }
            const response = data as PhashWorkerResponse;
            phashWorker.removeEventListener("message", handleMessage);
            if (response.error || !response.hashes || !response.color || !response.grid) {
                reject(new Error(response.error ?? "Hash failed"));
                return;
            }
            resolve({
                hashes: response.hashes,
                color: response.color,
                grid: response.grid,
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
 * the worker thread. Prefer {@link checkCropMatchBatchInWorkers} for Stage-2.
 */
export const checkCropMatchInWorkers = (
    aColor: string,
    aGrid: string,
    bColor: string,
    bGrid: string,
): Promise<boolean> =>
    checkCropMatchBatchInWorkers(
        {
            a: { color: aColor, grid: aGrid },
            b: { color: bColor, grid: bGrid },
        },
        [["a", "b"]],
    ).then((matches) => matches[0] ?? false);

export type CropBatchEntry = { color: string; grid: string };

/**
 * Batch crop checks across the worker pool. Unique grids are decoded once per
 * worker chunk; pairs are split round-robin so cores stay busy.
 */
export const checkCropMatchBatchInWorkers = (
    entries: Record<string, CropBatchEntry>,
    pairs: Array<[string, string]>,
): Promise<boolean[]> => {
    if (pairs.length === 0) {
        return Promise.resolve([]);
    }

    const pool = getPhashWorkers();
    const chunkCount = Math.min(pool.length, pairs.length);
    const matches = new Array<boolean>(pairs.length).fill(false);

    const runChunk = (
        worker: Worker,
        chunkPairs: Array<[string, string]>,
        absoluteIndexes: number[],
    ): Promise<void> =>
        new Promise((resolve) => {
            const usedKeys = new Set<string>();
            for (const [a, b] of chunkPairs) {
                usedKeys.add(a);
                usedKeys.add(b);
            }
            const chunkEntries: Record<string, CropBatchEntry> = {};
            for (const key of usedKeys) {
                const entry = entries[key];
                if (entry) {
                    chunkEntries[key] = entry;
                }
            }

            const requestId = ++requestCounter;
            const handleMessage = (
                event: MessageEvent<PhashWorkerOutbound>,
            ): void => {
                const data = event.data;
                if (
                    !("kind" in data) ||
                    data.kind !== "crop-check-batch" ||
                    data.id !== requestId
                ) {
                    return;
                }
                const response = data as CropCheckBatchResult;
                worker.removeEventListener("message", handleMessage);
                const verdicts = response.matches;
                for (let i = 0; i < absoluteIndexes.length; i++) {
                    matches[absoluteIndexes[i]!] = verdicts[i] ?? false;
                }
                resolve();
            };

            worker.addEventListener("message", handleMessage);
            const message: CropCheckBatchMessage = {
                kind: "crop-check-batch",
                id: requestId,
                entries: chunkEntries,
                pairs: chunkPairs,
            };
            worker.postMessage(message);
        });

    const chunkPairs: Array<Array<[string, string]>> = Array.from(
        { length: chunkCount },
        () => [],
    );
    const chunkIndexes: number[][] = Array.from(
        { length: chunkCount },
        () => [],
    );
    for (let i = 0; i < pairs.length; i++) {
        const chunk = i % chunkCount;
        chunkPairs[chunk]!.push(pairs[i]!);
        chunkIndexes[chunk]!.push(i);
    }

    return Promise.all(
        chunkPairs.map((pairsForChunk, chunk) => {
            if (pairsForChunk.length === 0) {
                return Promise.resolve();
            }
            return runChunk(
                pool[chunk]!,
                pairsForChunk,
                chunkIndexes[chunk]!,
            );
        }),
    ).then(() => matches);
};

/**
 * Owned still images only. Used for dHash scan and CLIP embed — videos and
 * archived files are excluded (archived = long-term storage, not active gallery).
 */
export const imageFilesForPhash = (
    files: EnteFile[],
    userId: number,
): EnteFile[] =>
    files.filter(
        (file) =>
            file.ownerID === userId &&
            file.metadata.fileType === FileType.image &&
            !isFileArchivedLocally(file),
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
        await waitWhileGalleryScrolling(options.signal);
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

export interface Stage1WorkerOptions {
    onProgress?: (update: Stage1ProgressUpdate) => void;
    signal?: AbortSignal;
    /** CLIP vectors for nearest-neighbour Similar (file id → L2-normalized). */
    embeddings?: ReadonlyMap<number, readonly number[]>;
}

export type Stage1WorkerResult = {
    clusters: Stage1Cluster[];
    edges: Stage1FileEdge[];
};

/**
 * Run Stage-1 clustering on a dedicated worker so the UI thread stays free.
 * Progress (and provisional tight-match groups) stream back via {@link onProgress}.
 * Returns clusters for the requested threshold plus edges collected up to
 * {@link EDGE_COLLECT_THRESHOLD} for later threshold changes.
 */
export const runStage1InWorker = (
    items: Stage1Item[],
    threshold: number,
    options: Stage1WorkerOptions = {},
): Promise<Stage1WorkerResult> =>
    new Promise((resolve, reject) => {
        if (items.length < 2) {
            options.onProgress?.({
                phase: "done",
                completed: 0,
                total: 0,
                clusters: [],
            });
            resolve({ clusters: [], edges: [] });
            return;
        }

        const requestId = ++requestCounter;
        const worker = new Worker(
            new URL("../workers/phash.worker.ts", import.meta.url),
        );
        let settled = false;

        const cleanup = (): void => {
            options.signal?.removeEventListener("abort", onAbort);
            worker.terminate();
        };

        const fail = (error: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };

        const succeed = (result: Stage1WorkerResult): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(result);
        };

        const onAbort = (): void => {
            worker.postMessage({ kind: "stage1-abort", id: requestId });
            fail(new DOMException("Similarity grouping aborted", "AbortError"));
        };

        if (options.signal?.aborted) {
            fail(new DOMException("Similarity grouping aborted", "AbortError"));
            return;
        }
        options.signal?.addEventListener("abort", onAbort);

        worker.onmessage = (event: MessageEvent<PhashWorkerOutbound>): void => {
            const data = event.data;
            if (!("kind" in data) || data.id !== requestId) {
                return;
            }
            if (data.kind === "stage1-progress") {
                options.onProgress?.(data.update);
                return;
            }
            if (data.kind === "stage1-result") {
                if (data.error) {
                    fail(new Error(data.error));
                    return;
                }
                succeed({
                    clusters: data.clusters ?? [],
                    edges: data.edges ?? [],
                });
            }
        };

        worker.onerror = (event: ErrorEvent): void => {
            fail(new Error(event.message || "Stage-1 worker failed"));
        };

        let embeddingsByFileId: Record<string, number[]> | undefined;
        if (options.embeddings && options.embeddings.size > 0) {
            embeddingsByFileId = {};
            for (const item of items) {
                const vector = options.embeddings.get(item.fileId);
                if (vector) {
                    embeddingsByFileId[String(item.fileId)] = [...vector];
                }
            }
            if (Object.keys(embeddingsByFileId).length === 0) {
                embeddingsByFileId = undefined;
            }
        }

        const message: Stage1Message = {
            kind: "stage1",
            id: requestId,
            items,
            threshold,
            embeddingsByFileId,
        };
        worker.postMessage(message);
    });
