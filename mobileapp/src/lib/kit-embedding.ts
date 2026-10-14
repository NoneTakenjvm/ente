import { registerReset } from "@/lib/session-lifecycle";
/**
 * On-device CLIP image embeddings for kit nearness ranking.
 *
 * Inference runs in {@link ../workers/clip-embedding.worker.ts} (Transformers.js
 * + Xenova MobileCLIP-S2 vision tower). Loads WASM `fp32` first (ORT init),
 * then upgrades to WebGPU `fp32` if the FastViT graph runs. Quantized S2 is
 * skipped — the Xenova config pins vision to fp32.
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
 * {@link eligibleImageFiles}; any stale video vectors in {@link existing} are
 * dropped at job start.
 */
import {
    KIT_EMBEDDING_DIMS,
    KIT_EMBEDDING_MODEL_ID,
} from "@/lib/embedding-vector";
import { createWorkerClient } from "@/lib/worker-client";
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
import {
    eligibleImageFiles,
    progressReporter,
    runWithConcurrency,
} from "@/lib/job-utils";
import { isEnteVideoFile } from "@/lib/media-kind";
import { waitWhileGalleryScrolling } from "@/lib/gallery-scroll-activity";
import type { EnteFile } from "ente-media/file";
import { useSettingsStore } from "@/stores/settings-store";
import type {
    ClipEmbeddingBatchMode,
    ClipEmbeddingDevice,
    ClipEmbeddingDtype,
    ClipEmbeddingEmbedBatchDoneMessage,
    ClipEmbeddingInbound,
    ClipEmbeddingInitDoneMessage,
    ClipEmbeddingOutbound,
} from "@/workers/clip-embedding-worker-types";

export { KIT_EMBEDDING_DIMS, KIT_EMBEDDING_MODEL_ID };

/**
 * In-RAM CLIP vector. Packed floats use ~4 bytes/dim instead of JS number[]
 * (~8+ bytes/element plus array overhead) across the full index.
 */
export type EmbeddingVector = Float32Array;

export type EmbeddingMap = Map<number, EmbeddingVector>;
export type ReadonlyEmbeddingMap = ReadonlyMap<number, EmbeddingVector>;

type KitEmbeddingDevice = ClipEmbeddingDevice;

/**
 * Ensure a dims-checked Float32Array (returns the same instance when already packed).
 */
export const packEmbeddingVector = (
    data: ArrayLike<number>,
): EmbeddingVector | undefined => {
    if (data.length !== KIT_EMBEDDING_DIMS) {
        return undefined;
    }
    if (data instanceof Float32Array) {
        return data;
    }
    return Float32Array.from(data);
};

/** JSON / mldata wire form — number[] only. */
export const embeddingToNumberArray = (
    vector: ArrayLike<number>,
): number[] => (Array.isArray(vector) ? vector : Array.from(vector));

const thumbnailPrefetchConcurrency = 20;
/** Flush dirty vectors once this many accumulate. */
const writeChunkSize = 64;
/** UI progress updates — avoid setState on every embed. */
const progressMinIntervalMs = 200;

let activeDevice: KitEmbeddingDevice | undefined;
let activeDtype: ClipEmbeddingDtype | undefined;
let activeBatchMode: ClipEmbeddingBatchMode | undefined;
let batchFallbackReason: string | undefined;
/** Why WebGPU was skipped / failed (for Settings toast + console). */
let webGpuSkipReason: string | undefined;

let initPromise: Promise<void> | undefined;

const clipWorker = createWorkerClient<
    ClipEmbeddingInbound,
    ClipEmbeddingOutbound
>({
    createWorker: () =>
        new Worker(
            new URL("../workers/clip-embedding.worker.ts", import.meta.url),
        ),
});

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
const defaultKitEmbeddingBatchSizeFor = (
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
const resolveKitEmbeddingBatchSize = (
    device: KitEmbeddingDevice,
    setting: number,
): number => {
    const clamped = clampClipEmbeddingBatchSize(setting);
    if (clamped === CLIP_EMBEDDING_BATCH_SIZE_AUTO) {
        return defaultKitEmbeddingBatchSizeFor(device);
    }
    return clamped;
};

/** Set when a true batch forward failed and the worker serialised. */
export const getKitEmbeddingBatchFallbackReason = (): string | undefined =>
    batchFallbackReason;

/** Human-readable reason when the session fell back to WASM. */
export const getKitEmbeddingWebGpuSkipReason = (): string | undefined =>
    webGpuSkipReason;

/** Forget what the worker reported, e.g. after it died or was terminated. */
const resetWorkerState = (): void => {
    initPromise = undefined;
    activeDevice = undefined;
    activeDtype = undefined;
    activeBatchMode = undefined;
    batchFallbackReason = undefined;
    webGpuSkipReason = undefined;
};

/** Load the model (WASM, then WebGPU upgrade) if it is not already resident. */
const ensureKitEmbeddingWorkerReady = (): Promise<void> => {
    initPromise ??= clipWorker
        .request({ kind: "init" })
        .then((reply) => {
            const done = reply as ClipEmbeddingInitDoneMessage;
            if (done.error) {
                throw new Error(done.error);
            }
            activeDevice = done.device;
            activeDtype = done.dtype;
            webGpuSkipReason = done.webGpuSkipReason;
            if (webGpuSkipReason && done.device === "wasm") {
                console.warn(
                    "[kit-embedding] falling back to WASM:",
                    webGpuSkipReason,
                );
            }
            console.warn(
                `[kit-embedding] ${KIT_EMBEDDING_MODEL_ID} device=${done.device} dtype=${done.dtype ?? "?"}`,
            );
        })
        .catch((error: unknown) => {
            resetWorkerState();
            throw error;
        });
    return initPromise;
};

type EmbedBatchResults = ClipEmbeddingEmbedBatchDoneMessage["results"];

const embedBatchInWorker = async (
    items: Array<{ fileId: number; bytes: Uint8Array }>,
): Promise<EmbedBatchResults> => {
    const payload = items.map((item) => ({
        fileId: item.fileId,
        bytes: item.bytes.slice(),
    }));
    const done = (await clipWorker.request(
        { kind: "embed-batch", items: payload },
        payload.map((item) => item.bytes.buffer),
    )) as ClipEmbeddingEmbedBatchDoneMessage;
    if (done.error) {
        throw new Error(done.error);
    }
    if (done.batchMode) {
        activeBatchMode = done.batchMode;
    }
    if (done.batchFallbackReason) {
        batchFallbackReason = done.batchFallbackReason;
    }
    return done.results;
};

const emptyMeta = (): PersistedEmbeddingMeta => ({
    version: 2,
    modelId: KIT_EMBEDDING_MODEL_ID,
    dims: KIT_EMBEDDING_DIMS,
    nextChunkId: 0,
});

/**
 * Load the chunked embedding index (v2). Legacy v1 monolith is ignored.
 * Vectors are stored L2-normalized and packed as {@link Float32Array}.
 */
export const hydrateEmbeddingIndex = async (): Promise<EmbeddingMap> => {
    const cacheKey = getSessionCacheKey();
    const meta = await loadEmbeddingMeta(cacheKey);
    if (meta?.modelId !== KIT_EMBEDDING_MODEL_ID) {
        return new Map();
    }
    return loadAllEmbeddingChunks(meta, cacheKey);
};

/**
 * Drop embedding vectors for video files (poster thumbnail ≠ content).
 *
 * Returns the same map instance when nothing was removed.
 */
export const stripVideoEmbeddings = (
    entries: ReadonlyEmbeddingMap,
    files: readonly EnteFile[],
): EmbeddingMap => {
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
    private dirty: EmbeddingMap = new Map();
    private meta: PersistedEmbeddingMeta;
    private readonly cacheKey: string;
    private flushChain = Promise.resolve();
    private failures = 0;

    constructor(meta: PersistedEmbeddingMeta, cacheKey: string) {
        this.meta = meta;
        this.cacheKey = cacheKey;
    }

    enqueue(fileId: number, vector: EmbeddingVector): void {
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
                // Cross-device: upload this dirty batch (dynamic import avoids cycle).
                void import("@/lib/organizer-clip-sync").then(
                    ({ enqueueOrganizerClipUpload }) => {
                        enqueueOrganizerClipUpload(batch);
                    },
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

type KitEmbeddingProgress = {
    completed: number;
    total: number;
    phase: "model" | "embed";
    device?: KitEmbeddingDevice;
    dtype?: ClipEmbeddingDtype;
    /** ORT batch size requested (images per forward pass). */
    batchSize?: number;
    /** How the worker actually issued the last forward. */
    batchMode?: ClipEmbeddingBatchMode;
};

type RunKitEmbeddingJobOptions = {
    files: readonly EnteFile[];
    userId: number;
    existing?: EmbeddingMap;
    /**
     * When set, only these files are candidates (still must be owned images).
     * Default: every owned image in {@link files}.
     */
    onlyFileIds?: ReadonlySet<number>;
    onProgress?: (progress: KitEmbeddingProgress) => void;
    /**
     * Called after chunk flushes / job end so UI can refresh rankings.
     */
    onBatchPersisted?: (entries: EmbeddingMap) => void;
    signal?: AbortSignal;
};

type ReadyThumb = {
    file: EnteFile;
    bytes: Uint8Array;
};

/**
 * Embed owned images missing vectors. Prefetches thumbs, runs ORT in batches,
 * and flushes encrypted chunks via {@link EmbeddingWriteQueue}.
 */
export const runKitEmbeddingJob = async (
    options: RunKitEmbeddingJobOptions,
): Promise<EmbeddingMap> => {
    const cacheKey = getSessionCacheKey();
    // Always copy — the job mutates the map; don't alias the zustand store.
    const entries = new Map(
        stripVideoEmbeddings(
            options.existing ?? (await hydrateEmbeddingIndex()),
            options.files,
        ),
    );
    options.onProgress?.({ completed: 0, total: 1, phase: "model" });
    await ensureKitEmbeddingWorkerReady();
    const device = activeDevice ?? "wasm";
    const batchSize = resolveKitEmbeddingBatchSize(
        device,
        useSettingsStore.getState().clipEmbeddingBatchSize,
    );
    console.warn(
        `[kit-embedding] ${KIT_EMBEDDING_MODEL_ID} device=${device} dtype=${activeDtype ?? "?"} batchSize=${batchSize}`,
    );
    options.onProgress?.({
        completed: 0,
        total: 1,
        phase: "model",
        device,
        dtype: activeDtype,
        batchSize,
        batchMode: activeBatchMode,
    });
    const chunkSize = Math.max(batchSize * 3, 12);

    let candidates = eligibleImageFiles(options.files, options.userId);
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
            dtype: activeDtype,
            batchSize,
            batchMode: activeBatchMode,
        });
        return entries;
    }

    const meta = await ensureEmbeddingMeta(cacheKey);
    const writeQueue = new EmbeddingWriteQueue(meta, cacheKey);

    let completed = 0;

    const reportProgress = progressReporter(progressMinIntervalMs, () => {
        options.onProgress?.({
            completed,
            total,
            phase: "embed",
            device,
            dtype: activeDtype,
            batchSize,
            batchMode: activeBatchMode,
        });
    });
    const noteProgress = (force = false): void => {
        reportProgress(force || completed >= total);
    };

    /** Fetch one chunk of thumbnails; files without bytes count as skipped. */
    const prefetchChunk = async (files: EnteFile[]): Promise<ReadyThumb[]> => {
        const thumbs: ReadyThumb[] = [];
        await runWithConcurrency(
            files,
            thumbnailPrefetchConcurrency,
            async (file) => {
                if (options.signal?.aborted) {
                    return;
                }
                await waitWhileGalleryScrolling(options.signal);
                if (options.signal?.aborted) {
                    return;
                }
                const bytes = await getDecryptedThumbnailBytes(file);
                if (bytes) {
                    thumbs.push({ file, bytes });
                } else {
                    completed += 1;
                    noteProgress();
                }
            },
        );
        return thumbs;
    };

    const applyBatchResults = (results: EmbedBatchResults): void => {
        for (const result of results) {
            if (result.vector) {
                entries.set(result.fileId, result.vector);
                writeQueue.enqueue(result.fileId, result.vector);
            }
            completed += 1;
        }
        noteProgress();
    };

    /**
     * Keep up to two ORT batches in flight so the worker can decode batch
     * N+1 while the GPU runs N. Awaiting each batch before posting the next
     * was the "jumps of 8 then pause" boundary.
     */
    const maxInFlightBatches = 2;
    const inFlight: Array<Promise<EmbedBatchResults>> = [];
    const applyOldestBatch = async (): Promise<void> => {
        const finished = await inFlight.shift();
        if (finished) {
            applyBatchResults(finished);
        }
    };

    const chunks: EnteFile[][] = [];
    for (let start = 0; start < todo.length; start += chunkSize) {
        chunks.push(todo.slice(start, start + chunkSize));
    }
    // The next chunk is fetched while the current one is embedded.
    let nextThumbs: Promise<ReadyThumb[]> | undefined = prefetchChunk(
        chunks[0]!,
    );

    try {
        noteProgress(true);
        for (let index = 0; index < chunks.length; index += 1) {
            if (options.signal?.aborted) {
                break;
            }
            const thumbs = (await nextThumbs)!;
            nextThumbs =
                index + 1 < chunks.length ?
                    prefetchChunk(chunks[index + 1]!) :
                    undefined;
            for (let start = 0; start < thumbs.length; start += batchSize) {
                if (options.signal?.aborted) {
                    break;
                }
                inFlight.push(
                    embedBatchInWorker(
                        thumbs.slice(start, start + batchSize).map((item) => ({
                            fileId: item.file.id,
                            bytes: item.bytes,
                        })),
                    ),
                );
                if (inFlight.length >= maxInFlightBatches) {
                    await applyOldestBatch();
                }
            }
        }
        while (inFlight.length > 0) {
            await applyOldestBatch();
        }
    } finally {
        // Settle fetches and batches left over by an abort or a failed batch.
        await nextThumbs?.catch(() => undefined);
        await Promise.allSettled(inFlight);
        noteProgress(true);
        await writeQueue.drain();
        options.onBatchPersisted?.(entries);
    }

    return entries;
};

/** Tear down the CLIP worker (e.g. on logout). Safe to call when unused. */
const terminateKitEmbeddingWorker = (): void => {
    clipWorker.terminate(new Error("CLIP worker terminated"));
    resetWorkerState();
};

registerReset(terminateKitEmbeddingWorker);
