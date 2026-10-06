import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import type { PhashEntry } from "@/lib/crop-match";
import {
    appendPhashChunk,
    clearPhashChunks,
    loadAllPhashChunks,
    loadPhashMeta,
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
import type { ReadonlyEmbeddingMap } from "@/lib/kit-embedding";
import type {
    CropCheckBatchMessage,
    CropCheckBatchResult,
    PhashWorkerOutbound,
    PhashWorkerRequest,
    PhashWorkerResponse,
    Stage1Message,
} from "@/workers/phash-worker-types";

export interface PhashJobOptions {
    /** Every file the index should cover; entries for other ids are dropped. */
    files: EnteFile[];
    entries: Map<number, PhashEntry>;
    onProgress?: (current: number, total: number) => void;
    shouldPause?: () => boolean;
    signal?: AbortSignal;
}

const phashWorkerCount = (): number => {
    if (typeof navigator === "undefined") {
        return 4;
    }
    return Math.min(8, Math.max(2, navigator.hardwareConcurrency ?? 4));
};

let workers: Worker[] | undefined;
let nextWorkerIndex = 0;
let requestCounter = 0;
/**
 * Reply handlers for requests posted to the shared pool, keyed by request id.
 * Each worker has one `onmessage` that dispatches here; an `Error` means the
 * pool was terminated before the worker replied.
 */
const pendingReplies = new Map<
    number,
    (reply: PhashWorkerOutbound | Error) => void
>();

const getPhashWorkers = (): Worker[] => {
    if (!workers) {
        workers = Array.from({ length: phashWorkerCount() }, () => {
            const worker = new Worker(
                new URL("../workers/phash.worker.ts", import.meta.url),
            );
            worker.onmessage = (
                event: MessageEvent<PhashWorkerOutbound>,
            ): void => {
                const reply = pendingReplies.get(event.data.id);
                if (reply) {
                    pendingReplies.delete(event.data.id);
                    reply(event.data);
                }
            };
            // A worker that fails to load or crashes never replies; reject
            // everything pending so the job's in-flight cap cannot stall.
            worker.onerror = (): void => {
                terminatePhashWorker();
            };
            return worker;
        });
    }
    return workers;
};

/** Pick the next worker round-robin from the shared pool. */
const nextWorker = (): Worker => {
    const pool = getPhashWorkers();
    const worker = pool[nextWorkerIndex % pool.length]!;
    nextWorkerIndex += 1;
    return worker;
};

const hashBytesInWorker = (
    fileId: number,
    bytes: Uint8Array,
): Promise<PhashEntry> =>
    new Promise((resolve, reject) => {
        const worker = nextWorker();
        const requestId = ++requestCounter;
        pendingReplies.set(requestId, (reply) => {
            if (reply instanceof Error) {
                reject(reply);
                return;
            }
            const response = reply as PhashWorkerResponse;
            if (
                response.error ||
                !response.hashes ||
                !response.color ||
                !response.grid
            ) {
                reject(new Error(response.error ?? "Hash failed"));
                return;
            }
            resolve({
                hashes: response.hashes,
                color: response.color,
                grid: response.grid,
            });
        });
        const request: PhashWorkerRequest = {
            kind: "hash",
            id: requestId,
            fileId,
            bytes,
        };
        // Thumbnail bytes are a fresh decrypt per call, so hand the buffer over.
        worker.postMessage(request, [bytes.buffer as ArrayBuffer]);
    });

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
 * worker chunk; pairs are split round-robin so cores stay busy. Rejects if the
 * pool is terminated mid-batch.
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
        new Promise((resolve, reject) => {
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
            pendingReplies.set(requestId, (reply) => {
                if (reply instanceof Error) {
                    reject(reply);
                    return;
                }
                const verdicts = (reply as CropCheckBatchResult).matches;
                for (let i = 0; i < absoluteIndexes.length; i++) {
                    matches[absoluteIndexes[i]!] = verdicts[i] ?? false;
                }
                resolve();
            });
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

/** Serializes phash index writes so chunk ids are allocated one at a time. */
let phashWriteChain: Promise<void> = Promise.resolve();

/**
 * Load the persisted phash index. A missing or outdated index is reset so its
 * old blob stops being read on every launch; the next job rehashes.
 */
export const hydratePhashIndex = async (): Promise<Map<number, PhashEntry>> => {
    const cacheKey = getSessionCacheKey();
    await phashWriteChain;
    if (!(await loadPhashMeta(cacheKey))) {
        await queuePhashWrite(() => clearPhashChunks(cacheKey));
        return new Map();
    }
    return loadAllPhashChunks(cacheKey);
};

/**
 * Drop a single file from the persisted phash index (e.g. after thumbnail change).
 */
export const removePhashEntry = (fileId: number): Promise<void> =>
    queuePhashWrite(() =>
        appendPhashChunk(new Map([[fileId, null]]), getSessionCacheKey()));

/** New hashes are persisted in chunks this size so progress survives interruption. */
const flushEvery = 64;
/** Entries per chunk when the index is rewritten whole. */
const compactChunkSize = 1024;
/** Chunks allowed beyond twice the compacted count before a rewrite. */
const maxExtraChunks = 64;
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
 * Compute dHash + crop signals for image files missing from the index,
 * persisting new entries in small encrypted chunks. Entries for files not in
 * `files` (deleted, archived, or no longer owned) are dropped.
 */
export const runPhashJob = async (
    options: PhashJobOptions,
): Promise<Map<number, PhashEntry>> => {
    const cacheKey = getSessionCacheKey();
    const liveIds = new Set(options.files.map((file) => file.id));
    const entries = new Map<number, PhashEntry>();
    const prunedIds: number[] = [];
    for (const [fileId, entry] of options.entries) {
        if (liveIds.has(fileId)) {
            entries.set(fileId, entry);
        } else {
            prunedIds.push(fileId);
        }
    }

    const meta = await loadPhashMeta(cacheKey);
    const compactedChunkCount = Math.ceil(entries.size / compactChunkSize);
    if (
        !meta ||
        meta.nextChunkId > 2 * compactedChunkCount + maxExtraChunks
    ) {
        const snapshot = new Map(entries);
        void queuePhashWrite(() => rewritePhashChunks(snapshot, cacheKey));
    } else if (prunedIds.length > 0) {
        const removals = new Map(prunedIds.map((id) => [id, null] as const));
        void queuePhashWrite(() => appendPhashChunk(removals, cacheKey));
    }

    const candidates = options.files
        .filter((file) => !entries.has(file.id))
        .sort((a, b) => a.id - b.id);

    const total = candidates.length;
    let completed = 0;

    if (total === 0) {
        await phashWriteChain;
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

    const pending = new Map<number, PhashEntry>();
    const flushPending = (): void => {
        const chunk = new Map(pending);
        pending.clear();
        void queuePhashWrite(() => appendPhashChunk(chunk, cacheKey));
    };

    // Workers decode concurrently (their handler awaits `createImageBitmap`),
    // so every posted hash holds a bitmap and canvas until it finishes. Cap
    // the in-flight count; fetched thumbnails wait here as small byte buffers.
    const maxInFlightHashes = 2 * phashWorkerCount();
    let inFlightHashes = 0;
    const hashSlotWaiters: Array<() => void> = [];

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
            while (inFlightHashes >= maxInFlightHashes) {
                await new Promise<void>((resolve) => {
                    hashSlotWaiters.push(resolve);
                });
            }
            if (options.signal?.aborted) {
                return;
            }
            inFlightHashes += 1;
            try {
                const entry = await hashBytesInWorker(file.id, bytes);
                entries.set(file.id, entry);
                pending.set(file.id, entry);
                if (pending.size >= flushEvery) {
                    flushPending();
                }
            } catch {
                // Skip files we cannot hash.
            } finally {
                inFlightHashes -= 1;
                hashSlotWaiters.shift()?.();
            }
        }

        completed += 1;
        options.onProgress?.(completed, total);
    };

    await Promise.all([
        runWithConcurrency(cachedFiles, cachedThumbnailConcurrency, processOne),
        runWithConcurrency(networkFiles, networkThumbnailConcurrency, processOne),
    ]);

    if (pending.size > 0) {
        flushPending();
    }
    await phashWriteChain;
    return entries;
};

/**
 * Terminate the shared hash / crop-check pool. Requests still in flight
 * reject so their callers (and the job's in-flight cap) settle.
 */
export const terminatePhashWorker = (): void => {
    workers?.forEach((worker) => {
        worker.terminate();
    });
    workers = undefined;
    nextWorkerIndex = 0;
    const replies = [...pendingReplies.values()];
    pendingReplies.clear();
    for (const reply of replies) {
        reply(new Error("Phash workers terminated"));
    }
};

export interface Stage1WorkerOptions {
    onProgress?: (update: Stage1ProgressUpdate) => void;
    signal?: AbortSignal;
    /** CLIP vectors for nearest-neighbour Similar (file id → L2-normalized). */
    embeddings?: ReadonlyEmbeddingMap;
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

        const embeddings = options.embeddings ?
            packStage1Embeddings(items, options.embeddings) :
            undefined;
        const message: Stage1Message = {
            kind: "stage1",
            id: requestId,
            items,
            threshold,
            embeddings,
        };
        worker.postMessage(
            message,
            embeddings ?
                [
                    embeddings.vectors.buffer as ArrayBuffer,
                    embeddings.fileIds.buffer as ArrayBuffer,
                ] :
                [],
        );
    });

/** Chain a phash index write after earlier ones; failures are logged, not thrown. */
const queuePhashWrite = (task: () => Promise<void>): Promise<void> => {
    phashWriteChain = phashWriteChain.then(task).catch((error: unknown) => {
        console.warn("[phash] index write failed", error);
    });
    return phashWriteChain;
};

/** Replace the persisted index with `entries`, in large chunks. */
const rewritePhashChunks = async (
    entries: ReadonlyMap<number, PhashEntry>,
    cacheKey: string,
): Promise<void> => {
    await clearPhashChunks(cacheKey);
    let chunk = new Map<number, PhashEntry>();
    for (const [fileId, entry] of entries) {
        chunk.set(fileId, entry);
        if (chunk.size >= compactChunkSize) {
            await appendPhashChunk(chunk, cacheKey);
            chunk = new Map();
        }
    }
    if (chunk.size > 0) {
        await appendPhashChunk(chunk, cacheKey);
    }
};

/**
 * Pack the items' CLIP vectors into one transferable buffer (row i belongs to
 * `fileIds[i]`) instead of structured-cloning thousands of arrays. Files
 * without a vector of the common length are left out.
 */
const packStage1Embeddings = (
    items: Stage1Item[],
    embeddings: ReadonlyEmbeddingMap,
): Stage1Message["embeddings"] => {
    let dims = 0;
    const rows: Array<[number, ArrayLike<number>]> = [];
    for (const item of items) {
        const vector = embeddings.get(item.fileId);
        if (!vector?.length) {
            continue;
        }
        dims ||= vector.length;
        if (vector.length === dims) {
            rows.push([item.fileId, vector]);
        }
    }
    if (rows.length === 0) {
        return undefined;
    }
    const vectors = new Float32Array(rows.length * dims);
    const fileIds = new Float64Array(rows.length);
    rows.forEach(([fileId, vector], row) => {
        vectors.set(vector, row * dims);
        fileIds[row] = fileId;
    });
    return { vectors, fileIds, dims };
};
