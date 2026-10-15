import type { EnteFile } from "ente-media/file";
import type { PhashEntry } from "@/lib/crop-match";
import {
    appendPhashChunk,
    clearPhashChunks,
    loadAllPhashChunks,
    loadPhashMeta,
} from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";
import { fileByteSize } from "@/lib/compress";
import { persistQualityIndex } from "@/lib/quality-index";
import {
    getDecryptedThumbnailBytes,
    isThumbnailCachedLocally,
} from "@/lib/thumbnail-bytes";
import { waitWhileGalleryScrolling } from "@/lib/gallery-scroll-activity";
import {
    eligibleImageFiles,
    runWithConcurrency,
    workerCount,
} from "@/lib/job-utils";
import {
    CLIP_SCORE_SLIDER_MAX,
    type ClipPairs,
} from "@/lib/similarity-clip";
import { KIT_EMBEDDING_DIMS } from "@/lib/kit-embedding";
import type {
    AnalyzeThumbnailRequest,
    AnalyzeThumbnailResponse,
    QualityScoreInputs,
} from "@/workers/phash-worker-types";
import type {
    SimilarPairsWorkerRequest,
    SimilarPairsWorkerResponse,
} from "@/workers/similar-pairs-worker-types";
import { registerReset } from "@/lib/session-lifecycle";
import { createWorkerClient } from "@/lib/worker-client";

export interface ThumbnailAnalysisOptions {
    /** Library files; only owned, non-archived stills are analysed. */
    files: EnteFile[];
    userId: number;
    phashEntries: Map<number, PhashEntry>;
    qualityEntries: Map<number, number>;
    onProgress?: (current: number, total: number) => void;
    signal?: AbortSignal;
}

export interface ThumbnailAnalysisResult {
    phashEntries: Map<number, PhashEntry>;
    qualityEntries: Map<number, number>;
}

/** Release the Similar pair worker after this long with no requests. */
const SIMILAR_PAIRS_IDLE_TERMINATE_MS = 30_000;

/** Shared thumbnail-analysis pool. */
const phashWorkers = createWorkerClient<
    AnalyzeThumbnailRequest,
    AnalyzeThumbnailResponse
>({
    createWorker: () =>
        new Worker(new URL("../workers/phash.worker.ts", import.meta.url)),
    poolSize: workerCount(),
});

const similarPairsWorker = createWorkerClient<
    SimilarPairsWorkerRequest,
    SimilarPairsWorkerResponse
>({
    createWorker: () =>
        new Worker(
            new URL("../workers/similar-pairs.worker.ts", import.meta.url),
        ),
    idleMs: SIMILAR_PAIRS_IDLE_TERMINATE_MS,
});

/** Decode `bytes` once in a worker and compute only the requested signals. */
const analyzeThumbnailInWorker = async (
    fileId: number,
    bytes: Uint8Array,
    needsPhash: boolean,
    quality: QualityScoreInputs | undefined,
): Promise<AnalyzeThumbnailResponse> => {
    // Thumbnail bytes are a fresh decrypt per call, so hand the buffer over.
    const response = await phashWorkers.request(
        { kind: "analyze-thumbnail", fileId, bytes, needsPhash, quality },
        [bytes.buffer as ArrayBuffer],
    );
    if (
        response.error ||
        (needsPhash && !response.phashEntry) ||
        (quality && response.qualityScore === undefined)
    ) {
        throw new Error(response.error ?? "Thumbnail analysis failed");
    }
    return response;
};

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
 * Drop files from the persisted phash index in one chunk (e.g. after their
 * thumbnails changed).
 */
export const removePhashEntries = (fileIds: readonly number[]): Promise<void> =>
    queuePhashWrite(() =>
        appendPhashChunk(
            new Map(fileIds.map((fileId) => [fileId, null])),
            getSessionCacheKey(),
        ));

/** Drop a single file from the persisted phash index. */
export const removePhashEntry = (fileId: number): Promise<void> =>
    removePhashEntries([fileId]);

/** New hashes are persisted in chunks this size so progress survives interruption. */
const flushEvery = 64;
/** Entries per chunk when the index is rewritten whole. */
const compactChunkSize = 1024;
/** Chunks allowed beyond twice the compacted count before a rewrite. */
const maxExtraChunks = 64;
const cacheCheckConcurrency = 32;
const cachedThumbnailConcurrency = 32;
const networkThumbnailConcurrency = 8;

/** Eligible stills missing from the phash index, the quality index, or both. */
export const filesNeedingAnalysis = (
    files: readonly EnteFile[],
    userId: number,
    phashEntries: ReadonlyMap<number, PhashEntry>,
    qualityEntries: ReadonlyMap<number, number>,
): EnteFile[] =>
    eligibleImageFiles(files, userId).filter(
        (file) => !phashEntries.has(file.id) || !qualityEntries.has(file.id),
    );

/**
 * Decode each eligible thumbnail once and fill in whichever of its dHash +
 * crop signals and quality score are missing. The two indexes stay persisted
 * and versioned separately, so a file missing only one signal does not
 * recompute the other. New hashes are persisted in small encrypted chunks and
 * quality scores as a whole index, both incrementally. Phash entries for
 * files no longer eligible (deleted, archived, or not owned) are dropped.
 */
export const runThumbnailAnalysisJob = async (
    options: ThumbnailAnalysisOptions,
): Promise<ThumbnailAnalysisResult> => {
    const cacheKey = getSessionCacheKey();
    const liveIds = new Set(
        eligibleImageFiles(options.files, options.userId).map(
            (file) => file.id,
        ),
    );
    const phashEntries = new Map<number, PhashEntry>();
    const prunedIds: number[] = [];
    for (const [fileId, entry] of options.phashEntries) {
        if (liveIds.has(fileId)) {
            phashEntries.set(fileId, entry);
        } else {
            prunedIds.push(fileId);
        }
    }
    const qualityEntries = new Map(options.qualityEntries);

    const meta = await loadPhashMeta(cacheKey);
    const compactedChunkCount = Math.ceil(phashEntries.size / compactChunkSize);
    if (
        !meta ||
        meta.nextChunkId > 2 * compactedChunkCount + maxExtraChunks
    ) {
        const snapshot = new Map(phashEntries);
        void queuePhashWrite(() => rewritePhashChunks(snapshot, cacheKey));
    } else if (prunedIds.length > 0) {
        const removals = new Map(prunedIds.map((id) => [id, null] as const));
        void queuePhashWrite(() => appendPhashChunk(removals, cacheKey));
    }

    const candidates = filesNeedingAnalysis(
        options.files,
        options.userId,
        phashEntries,
        qualityEntries,
    ).sort((a, b) => a.id - b.id);

    const total = candidates.length;
    let completed = 0;

    if (total === 0) {
        await phashWriteChain;
        return { phashEntries, qualityEntries };
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

    const pendingPhash = new Map<number, PhashEntry>();
    const flushPendingPhash = (): void => {
        const chunk = new Map(pendingPhash);
        pendingPhash.clear();
        void queuePhashWrite(() => appendPhashChunk(chunk, cacheKey));
    };
    let qualityScoresSincePersist = 0;
    let qualityDirty = false;
    let qualityPersistChain = Promise.resolve();
    const persistQuality = (): Promise<void> => {
        qualityScoresSincePersist = 0;
        qualityPersistChain = qualityPersistChain
            .then(() => persistQualityIndex(qualityEntries))
            .catch((error: unknown) => {
                console.warn("Image quality index persist failed", error);
            });
        return qualityPersistChain;
    };

    // Workers decode concurrently (their handler awaits `createImageBitmap`),
    // so every posted analysis holds a bitmap and canvas until it finishes.
    // Cap the in-flight count; fetched thumbnails wait here as small byte
    // buffers.
    const maxInFlightAnalyses = 2 * workerCount();
    let inFlightAnalyses = 0;
    const slotWaiters: Array<() => void> = [];

    const processOne = async (file: EnteFile): Promise<void> => {
        if (options.signal?.aborted) {
            return;
        }
        await waitWhileGalleryScrolling(options.signal);
        if (options.signal?.aborted) {
            return;
        }
        const bytes = await getDecryptedThumbnailBytes(file);
        if (bytes) {
            while (inFlightAnalyses >= maxInFlightAnalyses) {
                await new Promise<void>((resolve) => {
                    slotWaiters.push(resolve);
                });
            }
            if (options.signal?.aborted) {
                return;
            }
            inFlightAnalyses += 1;
            try {
                const response = await analyzeThumbnailInWorker(
                    file.id,
                    bytes,
                    !phashEntries.has(file.id),
                    qualityEntries.has(file.id) ?
                        undefined :
                        qualityScoreInputs(file),
                );
                if (response.phashEntry) {
                    phashEntries.set(file.id, response.phashEntry);
                    pendingPhash.set(file.id, response.phashEntry);
                    if (pendingPhash.size >= flushEvery) {
                        flushPendingPhash();
                    }
                }
                if (response.qualityScore !== undefined) {
                    qualityEntries.set(file.id, response.qualityScore);
                    qualityDirty = true;
                    qualityScoresSincePersist += 1;
                    if (qualityScoresSincePersist >= flushEvery) {
                        await persistQuality();
                    }
                }
            } catch {
                // Skip files we cannot analyse.
            } finally {
                inFlightAnalyses -= 1;
                slotWaiters.shift()?.();
            }
        }

        completed += 1;
        options.onProgress?.(completed, total);
    };

    await Promise.all([
        runWithConcurrency(cachedFiles, cachedThumbnailConcurrency, processOne),
        runWithConcurrency(networkFiles, networkThumbnailConcurrency, processOne),
    ]);

    if (pendingPhash.size > 0) {
        flushPendingPhash();
    }
    if (qualityDirty) {
        await persistQuality();
    }
    await phashWriteChain;
    return { phashEntries, qualityEntries };
};

/**
 * Terminate the shared thumbnail-analysis pool. Requests still in flight
 * reject so their callers (and the job's in-flight cap) settle.
 */
export const terminatePhashWorker = (): void => {
    phashWorkers.terminate(new Error("Phash workers terminated"));
};

/**
 * Collect every CLIP pair within {@link CLIP_SCORE_SLIDER_MAX} in a worker,
 * so any slider position regroups without rescanning.
 *
 * Transfers {@link packed}; the caller must not reuse that buffer.
 *
 * @param fileIds row i of {@link packed} belongs to `fileIds[i]`
 */
export const findSimilarPairsInWorker = async (
    fileIds: readonly number[],
    packed: Float32Array,
    onProgress: (completed: number, total: number) => void,
): Promise<ClipPairs> => {
    const idBuffer = Float64Array.from(fileIds);
    const response = await similarPairsWorker.request(
        {
            fileIds: idBuffer,
            packed,
            dims: KIT_EMBEDDING_DIMS,
            maxScore: CLIP_SCORE_SLIDER_MAX,
        },
        [idBuffer.buffer, packed.buffer],
        (progress) => {
            onProgress(progress.completed ?? 0, progress.total ?? 0);
        },
    );
    if (response.error || !response.pairs) {
        throw new Error(response.error ?? "Similar scan failed");
    }
    return response.pairs;
};

/** Stop a running Similar pair scan (its promise rejects). */
export const cancelSimilarPairsInWorker = (): void => {
    similarPairsWorker.terminate(new Error("Similar scan cancelled"));
};

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

/** Original dimensions and size the quality score compares the thumbnail against. */
const qualityScoreInputs = (file: EnteFile): QualityScoreInputs => {
    const data = file.pubMagicMetadata?.data;
    return {
        originalWidth: typeof data?.w === "number" ? data.w : 0,
        originalHeight: typeof data?.h === "number" ? data.h : 0,
        fileBytes: fileByteSize(file),
    };
};

registerReset(terminatePhashWorker);
registerReset(cancelSimilarPairsInWorker);
