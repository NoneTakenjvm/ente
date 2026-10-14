import type { EnteFile } from "ente-media/file";
import { loadKv, saveKv, type PersistedQualityIndex } from "@/db/kv";
import { fileByteSize } from "@/lib/compress";
import { QUALITY_INDEX_VERSION } from "@/lib/image-quality";
import {
    getDecryptedThumbnailBytes,
    isThumbnailCachedLocally,
} from "@/lib/thumbnail-bytes";
import {
    eligibleImageFiles,
    runWithConcurrency,
    waitIfPaused,
    workerCount,
} from "@/lib/job-utils";
import { waitWhileGalleryScrolling } from "@/lib/gallery-scroll-activity";
import { createWorkerClient } from "@/lib/worker-client";
import type {
    ImageQualityWorkerRequest,
    ImageQualityWorkerResponse,
} from "@/workers/image-quality.worker";

export interface ImageQualityJobOptions {
    files: EnteFile[];
    userId: number;
    entries: Map<number, number>;
    onProgress?: (current: number, total: number) => void;
    shouldPause?: () => boolean;
    signal?: AbortSignal;
}

const indexFromMap = (entries: Map<number, number>): PersistedQualityIndex => ({
    version: QUALITY_INDEX_VERSION,
    entries: Object.fromEntries(entries.entries()),
});

const persistIndex = async (entries: Map<number, number>): Promise<void> => {
    await saveKv("qualityIndex", indexFromMap(entries));
};

const qualityWorkers = createWorkerClient<
    ImageQualityWorkerRequest,
    ImageQualityWorkerResponse
>({
    createWorker: () =>
        new Worker(
            new URL("../workers/image-quality.worker.ts", import.meta.url),
        ),
    poolSize: workerCount(),
});

const scoreBytesInWorker = async (
    fileId: number,
    bytes: Uint8Array,
    originalWidth: number,
    originalHeight: number,
    fileBytes: number,
): Promise<number> => {
    const copy = bytes.slice();
    const response = await qualityWorkers.request(
        { fileId, bytes: copy, originalWidth, originalHeight, fileBytes },
        [copy.buffer],
    );
    if (response.error !== undefined || response.score === undefined) {
        throw new Error(response.error ?? "Quality score failed");
    }
    return response.score;
};

/**
 * Load the encrypted quality index, or an empty map when missing/stale.
 *
 * [Note: quality index version] Scores are discarded when
 * `persisted.version !== QUALITY_INDEX_VERSION` so formula changes force a
 * Manage → Settings rescan rather than ranking with incompatible numbers.
 */
export const hydrateQualityIndex = async (): Promise<Map<number, number>> => {
    const persisted = await loadKv("qualityIndex");
    if (persisted?.version !== QUALITY_INDEX_VERSION) {
        return new Map();
    }
    const entries = new Map<number, number>();
    for (const [fileId, score] of Object.entries(persisted.entries)) {
        if (typeof score === "number" && Number.isFinite(score)) {
            entries.set(Number(fileId), score);
        }
    }
    return entries;
};

/** Write the index every N scores so progress survives interruption. */
const persistEvery = 64;
const cacheCheckConcurrency = 32;
const cachedThumbnailConcurrency = 32;
const networkThumbnailConcurrency = 8;

const originalDimensions = (
    file: EnteFile,
): { width: number; height: number } => {
    const data = file.pubMagicMetadata?.data;
    const width = typeof data?.w === "number" ? data.w : 0;
    const height = typeof data?.h === "number" ? data.h : 0;
    return { width, height };
};

/**
 * Score owned stills missing from the quality index; persist incrementally.
 */
export const runImageQualityJob = async (
    options: ImageQualityJobOptions,
): Promise<Map<number, number>> => {
    const candidates = eligibleImageFiles(options.files, options.userId)
        .filter((file) => !options.entries.has(file.id))
        .sort((a, b) => a.id - b.id);

    const total = candidates.length;
    let completed = 0;
    let scoresSincePersist = 0;
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

    const noteScored = async (): Promise<void> => {
        scoresSincePersist += 1;
        if (scoresSincePersist < persistEvery) {
            return;
        }
        scoresSincePersist = 0;
        persistChain = persistChain
            .then(() => persistIndex(entries))
            .catch((error: unknown) => {
                console.warn("Image quality index persist failed", error);
            });
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
                const dims = originalDimensions(file);
                const score = await scoreBytesInWorker(
                    file.id,
                    bytes,
                    dims.width,
                    dims.height,
                    fileByteSize(file),
                );
                entries.set(file.id, score);
                await noteScored();
            } catch {
                // Skip files we cannot score.
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
