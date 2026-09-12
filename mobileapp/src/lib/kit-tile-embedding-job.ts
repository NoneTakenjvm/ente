/**
 * Tile-embedding pilot scan (local builds only).
 *
 * For every owned still that already has a global CLIP vector, embed the
 * {@link kitTileGrid} tiles of its thumbnail in the CLIP worker and persist
 * them encrypted, one record per file. Photos carrying a kit-nearness tag go
 * first so the corpus export is usable before the whole library is done.
 * Resumable: files with stored tiles are skipped.
 *
 * Research: `scripts/kit-nearness-s2-research.md`, pass 5 "avenue 6".
 */
import { listTileEmbeddingFileIds, putTileEmbeddings } from "@/db/tile-embeddings";
import { embedKitTilesInWorker, ensureKitEmbeddingWorkerReady, KIT_EMBEDDING_MODEL_ID, type ReadonlyEmbeddingMap } from "@/lib/kit-embedding";
import { KIT_TILE_LAYOUT_ID } from "@/lib/kit-tile-layout";
import { imageFilesForPhash } from "@/lib/similarity-job";
import { getDecryptedThumbnailBytes } from "@/lib/thumbnail-bytes";
import type { EnteFile } from "ente-media/file";

export type KitTileEmbeddingCoverage = {
    /** Files with stored tiles / files eligible, across the whole library. */
    completed: number;
    total: number;
    /** Same, restricted to {@link KitTileEmbeddingJobInput.priorityFileIds}. */
    priorityCompleted: number;
    priorityTotal: number;
};

export type KitTileEmbeddingProgress = KitTileEmbeddingCoverage & {
    phase: "model" | "embed";
};

export type KitTileEmbeddingJobInput = {
    files: readonly EnteFile[];
    userId: number;
    /** Global CLIP index; only files present here are eligible. */
    embeddings: ReadonlyEmbeddingMap;
    /** Scanned before everything else (kit-nearness tagged photos). */
    priorityFileIds: ReadonlySet<number>;
};

export type RunKitTileEmbeddingJobOptions = KitTileEmbeddingJobInput & {
    onProgress?: (progress: KitTileEmbeddingProgress) => void;
    signal?: AbortSignal;
};

/** Thumbnails decrypting ahead of the worker. */
const PREFETCH_LOOKAHEAD = 6;

/** Photos in the worker at once (preprocessing of N+1 overlaps the forward of N). */
const MAX_IN_FLIGHT = 2;

const PROGRESS_MIN_INTERVAL_MS = 200;

/** Console cost breakdown every this many embedded photos. */
const TIMING_LOG_EVERY = 50;

/** Give up when the worker has failed this many photos without a single success. */
const MAX_FAILURES_BEFORE_ANY_SUCCESS = 5;

/** Coverage for the Manage status line before a scan starts. */
export const kitTileEmbeddingCoverage = async (
    input: KitTileEmbeddingJobInput,
): Promise<KitTileEmbeddingCoverage> =>
    coverageOf(
        await listTileEmbeddingFileIds(),
        eligibleFiles(input),
        input.priorityFileIds,
    );

/**
 * Embed and persist tiles for every eligible file without them. Resolves when
 * the queue is drained or `signal` aborts (in-flight photos still persist).
 */
export const runKitTileEmbeddingJob = async (
    options: RunKitTileEmbeddingJobOptions,
): Promise<void> => {
    const { priorityFileIds, signal } = options;
    const done = await listTileEmbeddingFileIds();
    const eligible = eligibleFiles(options);
    const progress: KitTileEmbeddingProgress = {
        phase: "model",
        ...coverageOf(done, eligible, priorityFileIds),
    };
    let lastProgressAt = 0;
    const noteProgress = (force = false): void => {
        const now = performance.now();
        if (!force && now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) {
            return;
        }
        lastProgressAt = now;
        options.onProgress?.({ ...progress });
    };

    const remaining = eligible.filter((file) => !done.has(file.id));
    const todo = [
        ...remaining.filter((file) => priorityFileIds.has(file.id)),
        ...remaining.filter((file) => !priorityFileIds.has(file.id)),
    ];
    noteProgress(true);
    if (todo.length === 0) {
        return;
    }
    await ensureKitEmbeddingWorkerReady();
    progress.phase = "embed";
    noteProgress(true);

    const startedAt = performance.now();
    const cost = { fetchMs: 0, preprocessMs: 0, forwardMs: 0, storeMs: 0 };
    let embedded = 0;
    let failures = 0;
    let lastError: unknown;
    const embedAndPersist = async (
        file: EnteFile,
        bytes: Uint8Array,
    ): Promise<void> => {
        try {
            const { tiles, timing } = await embedKitTilesInWorker(file.id, bytes);
            const storeStart = performance.now();
            await putTileEmbeddings(
                file.id,
                KIT_EMBEDDING_MODEL_ID,
                KIT_TILE_LAYOUT_ID,
                tiles,
            );
            cost.storeMs += performance.now() - storeStart;
            cost.preprocessMs += timing?.preprocessMs ?? 0;
            cost.forwardMs += timing?.forwardMs ?? 0;
            embedded += 1;
            progress.completed += 1;
            if (priorityFileIds.has(file.id)) {
                progress.priorityCompleted += 1;
            }
            noteProgress();
            if (embedded % TIMING_LOG_EVERY === 0) {
                const perPhoto = (total: number): string =>
                    (total / embedded).toFixed(0);
                console.warn(
                    `[kit-tiles] ${embedded} photos · ${perPhoto(performance.now() - startedAt)} ms/photo wall · ` +
                        `fetch ${perPhoto(cost.fetchMs)} · preprocess ${perPhoto(cost.preprocessMs)} · ` +
                        `forward ${perPhoto(cost.forwardMs)} · store ${perPhoto(cost.storeMs)} ms`,
                );
            }
        } catch (error) {
            failures += 1;
            lastError = error;
            if (failures <= 3) {
                console.warn("[kit-tiles] photo failed", error);
            }
        }
    };

    let nextIndex = 0;
    const fetching: Promise<{ file: EnteFile; bytes?: Uint8Array }>[] = [];
    const fillPrefetch = (): void => {
        while (
            fetching.length < PREFETCH_LOOKAHEAD &&
            nextIndex < todo.length &&
            !signal?.aborted
        ) {
            const file = todo[nextIndex]!;
            nextIndex += 1;
            const fetchStart = performance.now();
            fetching.push(
                getDecryptedThumbnailBytes(file).then((bytes) => {
                    cost.fetchMs += performance.now() - fetchStart;
                    return { file, bytes };
                }),
            );
        }
    };

    const inFlight: Promise<void>[] = [];
    fillPrefetch();
    while (fetching.length > 0 && !signal?.aborted) {
        const { file, bytes } = await fetching.shift()!;
        fillPrefetch();
        if (!bytes) {
            failures += 1;
            continue;
        }
        inFlight.push(embedAndPersist(file, bytes));
        if (inFlight.length >= MAX_IN_FLIGHT) {
            await inFlight.shift();
        }
        if (embedded === 0 && failures >= MAX_FAILURES_BEFORE_ANY_SUCCESS) {
            await Promise.all(inFlight);
            throw lastError instanceof Error ?
                lastError :
                new Error("Tile scan failed for every photo");
        }
    }
    await Promise.all(inFlight);
    await Promise.allSettled(fetching);
    noteProgress(true);
    if (failures > 0) {
        console.warn(`[kit-tiles] ${failures} photo(s) skipped`);
    }
};

const eligibleFiles = (
    input: Pick<KitTileEmbeddingJobInput, "files" | "userId" | "embeddings">,
): EnteFile[] =>
    imageFilesForPhash([...input.files], input.userId).filter((file) =>
        input.embeddings.has(file.id));

const coverageOf = (
    done: ReadonlySet<number>,
    eligible: readonly EnteFile[],
    priorityFileIds: ReadonlySet<number>,
): KitTileEmbeddingCoverage => {
    const coverage: KitTileEmbeddingCoverage = {
        completed: 0,
        total: eligible.length,
        priorityCompleted: 0,
        priorityTotal: 0,
    };
    for (const file of eligible) {
        const isDone = done.has(file.id) ? 1 : 0;
        coverage.completed += isDone;
        if (priorityFileIds.has(file.id)) {
            coverage.priorityTotal += 1;
            coverage.priorityCompleted += isDone;
        }
    }
    return coverage;
};
