/**
 * On-device CLIP image embeddings for kit nearness ranking.
 *
 * Inference runs in {@link ../workers/clip-embedding.worker.ts} (Transformers.js
 * + Xenova CLIP ViT-B/16). Prefers WebGPU `fp16`, falls back to WASM `q8`.
 * Scan uses an ORT **batch size** (Auto or 4/8/12/16): multiple thumbnails go
 * through one forward pass. Up to two batches stay in flight so JPEG decode of
 * the next overlaps GPU work on the current. Embeddings are flushed to IDB as
 * encrypted chunks via an async write queue (O(batch), not O(library)). Changing
 * {@link KIT_EMBEDDING_MODEL_ID} invalidates the index.
 *
 * Full-library scans are started explicitly from Manage → Settings. Gallery kit
 * nearness only embeds missing seed thumbnails for the selected kit.
 *
 * Videos are never embedded (poster thumbnail ≠ content). Candidates come from
 * {@link imageFilesForPhash}; any stale video vectors in {@link existing} are
 * dropped at job start.
 */
import { getSessionCacheKey } from "@/lib/cache-key";
import {
    CLIP_EMBEDDING_BATCH_SIZE_AUTO,
    clampClipEmbeddingBatchSize,
} from "@/lib/app-settings";
import {
    getDecryptedThumbnailBytes,
} from "@/lib/thumbnail-bytes";
import {
    appendEmbeddingChunk,
    clearEmbeddingChunks,
    loadAllEmbeddingChunks,
    loadEmbeddingMeta,
    saveEmbeddingMeta,
    type PersistedEmbeddingMeta,
} from "@/db/kv";
import { imageFilesForPhash } from "@/lib/similarity-job";
import { isEnteVideoFile } from "@/lib/media-kind";
import type { EnteFile } from "ente-media/file";
import { useSettingsStore } from "@/stores/settings-store";
import type {
    ClipEmbeddingDevice,
    ClipEmbeddingEmbedBatchDoneMessage,
    ClipEmbeddingInbound,
    ClipEmbeddingInitDoneMessage,
    ClipEmbeddingOutbound,
} from "@/workers/clip-embedding-worker-types";

/** Model id baked into corpus exports so offline eval stays consistent. */
export const KIT_EMBEDDING_MODEL_ID = "Xenova/clip-vit-base-patch16";

export const KIT_EMBEDDING_DIMS = 512;

export type KitEmbeddingDevice = ClipEmbeddingDevice;

const thumbnailPrefetchConcurrency = 20;
/** Flush dirty vectors once this many accumulate. */
const writeChunkSize = 64;
/** UI progress updates — avoid setState on every embed. */
const progressMinIntervalMs = 200;

let activeDevice: KitEmbeddingDevice | undefined;
/** Why WebGPU was skipped / failed (for Settings toast + console). */
let webGpuSkipReason: string | undefined;

let clipWorker: Worker | undefined;
let requestCounter = 0;
let initPromise: Promise<void> | undefined;
let messageRouterAttached = false;

type PendingEmbedBatch = {
    resolve: (
        results: Array<{ fileId: number; vector?: number[] }>,
    ) => void;
    reject: (error: Error) => void;
};

type PendingInit = {
    id: number;
    resolve: () => void;
    reject: (error: Error) => void;
};

const pendingBatches = new Map<number, PendingEmbedBatch>();
let pendingInit: PendingInit | undefined;

const isCoarsePointerMobile = (): boolean => {
    if (typeof window === "undefined" || !window.matchMedia) {
        return false;
    }
    return window.matchMedia("(pointer: coarse)").matches;
};

/**
 * Default ORT batch size when settings are Auto.
 * WebGPU benefits from larger batches; WASM stays small (CPU + memory).
 */
export const defaultKitEmbeddingBatchSizeFor = (
    device: KitEmbeddingDevice,
): number => {
    if (device === "webgpu") {
        return isCoarsePointerMobile() ? 2 : 6;
    }
    return isCoarsePointerMobile() ? 1 : 2;
};

/**
 * Resolve ORT batch size from a persisted setting (Auto or 4/8/12/16).
 */
export const resolveKitEmbeddingBatchSize = (
    device: KitEmbeddingDevice,
    setting: number,
): number => {
    const clamped = clampClipEmbeddingBatchSize(setting);
    if (clamped === CLIP_EMBEDDING_BATCH_SIZE_AUTO) {
        return defaultKitEmbeddingBatchSizeFor(device);
    }
    return clamped;
};

/** Active backend after the first model load (undefined until then). */
export const getKitEmbeddingDevice = (): KitEmbeddingDevice | undefined =>
    activeDevice;

/** Human-readable reason when the session fell back to WASM. */
export const getKitEmbeddingWebGpuSkipReason = (): string | undefined =>
    webGpuSkipReason;

const attachMessageRouter = (worker: Worker): void => {
    if (messageRouterAttached) {
        return;
    }
    messageRouterAttached = true;
    worker.onmessage = (event: MessageEvent<ClipEmbeddingOutbound>): void => {
        const data = event.data;
        if (data.kind === "init-done") {
            const init = pendingInit;
            if (init?.id !== data.id) {
                return;
            }
            pendingInit = undefined;
            const done = data as ClipEmbeddingInitDoneMessage;
            if (done.error) {
                initPromise = undefined;
                init.reject(new Error(done.error));
                return;
            }
            activeDevice = done.device;
            webGpuSkipReason = done.webGpuSkipReason;
            if (webGpuSkipReason && done.device === "wasm") {
                console.warn(
                    "[kit-embedding] falling back to WASM:",
                    webGpuSkipReason,
                );
            }
            init.resolve();
            return;
        }
        if (data.kind === "embed-batch-done") {
            const pending = pendingBatches.get(data.id);
            if (!pending) {
                return;
            }
            pendingBatches.delete(data.id);
            const done = data as ClipEmbeddingEmbedBatchDoneMessage;
            if (done.error) {
                pending.reject(new Error(done.error));
                return;
            }
            pending.resolve(done.results);
        }
        // Legacy single-embed replies are unused by the batch job path.
    };
};

const getClipWorker = (): Worker => {
    if (!clipWorker) {
        clipWorker = new Worker(
            new URL("../workers/clip-embedding.worker.ts", import.meta.url),
        );
        messageRouterAttached = false;
        attachMessageRouter(clipWorker);
    }
    return clipWorker;
};

const ensureClipWorkerReady = async (): Promise<void> => {
    if (!initPromise) {
        initPromise = new Promise<void>((resolve, reject) => {
            const worker = getClipWorker();
            attachMessageRouter(worker);
            const id = ++requestCounter;
            pendingInit = { id, resolve, reject };
            const message: ClipEmbeddingInbound = { kind: "init", id };
            worker.postMessage(message);
        });
    }
    await initPromise;
};

const embedBatchInWorker = (
    items: Array<{ fileId: number; bytes: Uint8Array }>,
): Promise<Array<{ fileId: number; vector?: number[] }>> =>
    new Promise((resolve, reject) => {
        const worker = getClipWorker();
        const id = ++requestCounter;
        const transferables: ArrayBuffer[] = [];
        const payload = items.map((item) => {
            const transfer = item.bytes.slice();
            transferables.push(transfer.buffer);
            return { fileId: item.fileId, bytes: transfer };
        });
        pendingBatches.set(id, { resolve, reject });
        const message: ClipEmbeddingInbound = {
            kind: "embed-batch",
            id,
            items: payload,
        };
        worker.postMessage(message, transferables);
    });

/** L2-normalize; returns undefined when empty / non-finite. */
const l2NormalizeEmbedding = (
    data: number[] | Float32Array,
): number[] | undefined => {
    let norm = 0;
    for (const value of data) {
        norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 0) {
        return undefined;
    }
    const out: number[] = [];
    for (const value of data) {
        out.push(Math.round((value / norm) * 1e5) / 1e5);
    }
    return out;
};

const emptyMeta = (): PersistedEmbeddingMeta => ({
    version: 2,
    modelId: KIT_EMBEDDING_MODEL_ID,
    dims: KIT_EMBEDDING_DIMS,
    nextChunkId: 0,
});

/**
 * Load the chunked embedding index (v2). Legacy v1 monolith is ignored.
 */
export const hydrateEmbeddingIndex = async (): Promise<
    Map<number, number[]>
> => {
    const cacheKey = getSessionCacheKey();
    const meta = await loadEmbeddingMeta(cacheKey);
    if (meta?.modelId !== KIT_EMBEDDING_MODEL_ID) {
        return new Map();
    }
    const map = await loadAllEmbeddingChunks(meta, cacheKey);
    const normalized = new Map<number, number[]>();
    for (const [id, vector] of map) {
        if (vector.length !== KIT_EMBEDDING_DIMS) {
            continue;
        }
        const next = l2NormalizeEmbedding(vector);
        if (next) {
            normalized.set(id, next);
        }
    }
    return normalized;
};

/**
 * Drop embedding vectors for video files (poster thumbnail ≠ content).
 *
 * Returns the same map instance when nothing was removed.
 */
export const stripVideoEmbeddings = (
    entries: ReadonlyMap<number, number[]>,
    files: readonly EnteFile[],
): Map<number, number[]> => {
    let removed = false;
    for (const file of files) {
        if (isEnteVideoFile(file) && entries.has(file.id)) {
            removed = true;
            break;
        }
    }
    if (!removed) {
        return entries instanceof Map ? entries : new Map(entries);
    }
    const next = new Map(entries);
    for (const file of files) {
        if (isEnteVideoFile(file)) {
            next.delete(file.id);
        }
    }
    return next;
};

/**
 * Async write queue: dirty vectors flush as encrypted IDB chunks without
 * blocking the embed loop. Each flush is O(dirty), not O(full library).
 */
class EmbeddingWriteQueue {
    private dirty = new Map<number, number[]>();
    private meta: PersistedEmbeddingMeta;
    private readonly cacheKey: string;
    private flushChain = Promise.resolve();
    private failures = 0;

    constructor(meta: PersistedEmbeddingMeta, cacheKey: string) {
        this.meta = meta;
        this.cacheKey = cacheKey;
    }

    enqueue(fileId: number, vector: number[]): void {
        this.dirty.set(fileId, vector);
        if (this.dirty.size >= writeChunkSize) {
            this.scheduleFlush();
        }
    }

    scheduleFlush(): void {
        if (this.dirty.size === 0) {
            return;
        }
        const batch = new Map(this.dirty);
        this.dirty.clear();
        this.flushChain = this.flushChain
            .then(async () => {
                this.meta = await appendEmbeddingChunk(
                    batch,
                    this.meta,
                    this.cacheKey,
                );
            })
            .catch((error: unknown) => {
                this.failures += 1;
                console.warn("[kit-embedding] chunk flush failed", error);
                // Re-queue so drain() can retry once at the end.
                for (const [id, vector] of batch) {
                    this.dirty.set(id, vector);
                }
            });
    }

    async drain(): Promise<void> {
        this.scheduleFlush();
        await this.flushChain;
        if (this.dirty.size > 0) {
            this.scheduleFlush();
            await this.flushChain;
        }
        if (this.failures > 0) {
            console.warn(
                `[kit-embedding] ${this.failures} chunk flush failure(s)`,
            );
        }
    }
}

/**
 * Ensure meta exists for this model (clears obsolete chunks when needed).
 */
const ensureEmbeddingMeta = async (
    cacheKey: string,
): Promise<PersistedEmbeddingMeta> => {
    const existing = await loadEmbeddingMeta(cacheKey);
    if (existing?.modelId === KIT_EMBEDDING_MODEL_ID) {
        return existing;
    }
    await clearEmbeddingChunks();
    const meta = emptyMeta();
    await saveEmbeddingMeta(meta, cacheKey);
    return meta;
};

export type KitEmbeddingProgress = {
    completed: number;
    total: number;
    phase: "model" | "embed";
    device?: KitEmbeddingDevice;
    /** ORT batch size (images per forward pass). */
    batchSize?: number;
};

export type RunKitEmbeddingJobOptions = {
    files: readonly EnteFile[];
    userId: number;
    existing?: Map<number, number[]>;
    /**
     * When set, only these files are candidates (still must be owned images).
     * Default: every owned image in {@link files}.
     */
    onlyFileIds?: ReadonlySet<number>;
    onProgress?: (progress: KitEmbeddingProgress) => void;
    /**
     * Called after chunk flushes / job end so UI can refresh rankings.
     */
    onBatchPersisted?: (entries: Map<number, number[]>) => void;
    /** When true, the job waits (like phash scan pause) instead of aborting. */
    shouldPause?: () => boolean;
    signal?: AbortSignal;
};

type ReadyThumb = {
    file: EnteFile;
    bytes: Uint8Array;
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

const runWithConcurrency = async <T>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<void>,
): Promise<void> => {
    if (!items.length) {
        return;
    }
    let index = 0;
    const runners = Array.from(
        { length: Math.min(limit, items.length) },
        async (): Promise<void> => {
            while (index < items.length) {
                const current = items[index]!;
                index += 1;
                await worker(current);
            }
        },
    );
    await Promise.all(runners);
};

/**
 * Embed owned images missing vectors. Prefetches thumbs, runs ORT in batches,
 * and flushes encrypted chunks via {@link EmbeddingWriteQueue}.
 */
export const runKitEmbeddingJob = async (
    options: RunKitEmbeddingJobOptions,
): Promise<Map<number, number[]>> => {
    const cacheKey = getSessionCacheKey();
    // Always copy — the job mutates the map; don't alias the zustand store.
    const entries = new Map(
        stripVideoEmbeddings(
            options.existing ?? (await hydrateEmbeddingIndex()),
            options.files,
        ),
    );
    options.onProgress?.({ completed: 0, total: 1, phase: "model" });
    await ensureClipWorkerReady();
    const device = activeDevice ?? "wasm";
    const batchSize = resolveKitEmbeddingBatchSize(
        device,
        useSettingsStore.getState().clipEmbeddingBatchSize,
    );
    console.warn(
        `[kit-embedding] device=${device} batchSize=${batchSize}`,
    );
    const maxReadyQueue = Math.max(batchSize * 3, 12);

    let candidates = imageFilesForPhash([...options.files], options.userId);
    if (options.onlyFileIds) {
        candidates = candidates.filter((file) =>
            options.onlyFileIds!.has(file.id));
    }
    const todo = candidates.filter((file) => !entries.has(file.id));
    const total = todo.length;
    if (total === 0) {
        options.onProgress?.({
            completed: 0,
            total: 0,
            phase: "embed",
            device,
            batchSize,
        });
        return entries;
    }

    const meta = await ensureEmbeddingMeta(cacheKey);
    const writeQueue = new EmbeddingWriteQueue(meta, cacheKey);

    let completed = 0;
    let lastProgressAt = 0;

    const noteProgress = (force = false): void => {
        const now = performance.now();
        if (
            !force &&
            now - lastProgressAt < progressMinIntervalMs &&
            completed < total
        ) {
            return;
        }
        lastProgressAt = now;
        options.onProgress?.({
            completed,
            total,
            phase: "embed",
            device,
            batchSize,
        });
    };

    const ready: ReadyThumb[] = [];
    let prefetchDone = false;
    const consumerWaiters: Array<() => void> = [];
    const prefetchWaiters: Array<() => void> = [];

    const wakeAllWaiters = (): void => {
        while (consumerWaiters.length > 0) {
            consumerWaiters.shift()?.();
        }
        while (prefetchWaiters.length > 0) {
            prefetchWaiters.shift()?.();
        }
    };

    const waitForConsumerSpace = async (): Promise<void> => {
        while (ready.length >= maxReadyQueue) {
            if (options.signal?.aborted) {
                return;
            }
            await new Promise<void>((resolve) => {
                prefetchWaiters.push(resolve);
            });
        }
    };

    const waitForReadyItem = async (): Promise<void> => {
        if (ready.length > 0 || prefetchDone || options.signal?.aborted) {
            return;
        }
        await new Promise<void>((resolve) => {
            consumerWaiters.push(resolve);
        });
    };

    const pushReady = (item: ReadyThumb): void => {
        ready.push(item);
        consumerWaiters.shift()?.();
    };

    const markSkipped = (): void => {
        completed += 1;
        noteProgress();
    };

    const prefetchOne = async (file: EnteFile): Promise<void> => {
        if (options.signal?.aborted) {
            return;
        }
        if (await waitIfPaused(options.shouldPause, options.signal)) {
            return;
        }
        await waitForConsumerSpace();
        if (options.signal?.aborted) {
            return;
        }
        const bytes = await getDecryptedThumbnailBytes(file);
        if (!bytes) {
            markSkipped();
            return;
        }
        pushReady({ file, bytes });
    };

    const prefetchPromise = runWithConcurrency(
        todo,
        thumbnailPrefetchConcurrency,
        prefetchOne,
    ).then(() => {
        prefetchDone = true;
        wakeAllWaiters();
    });

    const onAbort = (): void => {
        wakeAllWaiters();
    };
    options.signal?.addEventListener("abort", onAbort);

    const collectBatch = async (): Promise<ReadyThumb[]> => {
        const batch: ReadyThumb[] = [];
        while (batch.length < batchSize) {
            if (options.signal?.aborted) {
                break;
            }
            if (await waitIfPaused(options.shouldPause, options.signal)) {
                break;
            }
            await waitForReadyItem();
            const item = ready.shift();
            prefetchWaiters.shift()?.();
            if (!item) {
                if (prefetchDone || options.signal?.aborted) {
                    break;
                }
                continue;
            }
            batch.push(item);
        }
        return batch;
    };

    const applyBatchResults = (
        results: Array<{ fileId: number; vector?: number[] }>,
    ): void => {
        for (const result of results) {
            if (result.vector?.length === KIT_EMBEDDING_DIMS) {
                entries.set(result.fileId, result.vector);
                writeQueue.enqueue(result.fileId, result.vector);
            }
            completed += 1;
        }
        noteProgress();
    };

    try {
        noteProgress(true);
        /**
         * Keep up to two ORT batches in flight so the worker can decode batch
         * N+1 while the GPU runs N. Awaiting each batch before posting the next
         * was the “jumps of 8 then pause” boundary.
         */
        const maxInFlightBatches = 2;
        const inFlight: Array<
            Promise<Array<{ fileId: number; vector?: number[] }>>
        > = [];

        while (!options.signal?.aborted) {
            const batch = await collectBatch();
            if (batch.length === 0) {
                break;
            }
            inFlight.push(
                embedBatchInWorker(
                    batch.map((item) => ({
                        fileId: item.file.id,
                        bytes: item.bytes,
                    })),
                ),
            );
            if (inFlight.length >= maxInFlightBatches) {
                const finished = await inFlight.shift();
                if (finished) {
                    applyBatchResults(finished);
                }
            }
        }
        while (inFlight.length > 0) {
            const finished = await inFlight.shift();
            if (finished) {
                applyBatchResults(finished);
            }
        }
    } finally {
        options.signal?.removeEventListener("abort", onAbort);
        wakeAllWaiters();
        await prefetchPromise.catch(() => undefined);
        noteProgress(true);
        await writeQueue.drain();
        options.onBatchPersisted?.(entries);
    }

    return entries;
};

/** Tear down the CLIP worker (e.g. on logout). Safe to call when unused. */
export const terminateKitEmbeddingWorker = (): void => {
    for (const pending of pendingBatches.values()) {
        pending.reject(new Error("CLIP worker terminated"));
    }
    pendingBatches.clear();
    if (pendingInit) {
        pendingInit.reject(new Error("CLIP worker terminated"));
        pendingInit = undefined;
    }
    clipWorker?.terminate();
    clipWorker = undefined;
    messageRouterAttached = false;
    initPromise = undefined;
    activeDevice = undefined;
    webGpuSkipReason = undefined;
};
