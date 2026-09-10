import type { EnteFile } from "ente-media/file";
import {
    loadEncryptedQualityIndex,
    saveEncryptedQualityIndex,
    type PersistedQualityIndex,
} from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";
import { fileByteSize } from "@/lib/compress";
import { QUALITY_INDEX_VERSION } from "@/lib/image-quality";
import {
    getDecryptedThumbnailBytes,
    isThumbnailCachedLocally,
} from "@/lib/thumbnail-bytes";
import { imageFilesForPhash } from "@/lib/similarity-job";
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

const emptyIndex = (): PersistedQualityIndex => ({
    version: QUALITY_INDEX_VERSION,
    entries: {},
});

const indexFromMap = (entries: Map<number, number>): PersistedQualityIndex => ({
    version: QUALITY_INDEX_VERSION,
    entries: Object.fromEntries(entries.entries()),
});

const persistIndex = async (entries: Map<number, number>): Promise<void> => {
    await saveEncryptedQualityIndex(
        indexFromMap(entries),
        getSessionCacheKey(),
    );
};

const qualityWorkerCount = (): number => {
    if (typeof navigator === "undefined") {
        return 4;
    }
    return Math.min(8, Math.max(2, navigator.hardwareConcurrency ?? 4));
};

let workers: Worker[] | undefined;
let workerRoundRobin = 0;
let requestCounter = 0;

const getQualityWorkers = (): Worker[] => {
    if (!workers) {
        workers = Array.from({ length: qualityWorkerCount() }, () =>
            new Worker(
                new URL("../workers/image-quality.worker.ts", import.meta.url),
            ));
    }
    return workers;
};

const nextWorker = (): Worker => {
    const pool = getQualityWorkers();
    const worker = pool[workerRoundRobin % pool.length]!;
    workerRoundRobin += 1;
    return worker;
};

const scoreBytesInWorker = (
    fileId: number,
    bytes: Uint8Array,
    originalWidth: number,
    originalHeight: number,
    fileBytes: number,
): Promise<number> =>
    new Promise((resolve, reject) => {
        const worker = nextWorker();
        const requestId = ++requestCounter;

        const handleMessage = (
            event: MessageEvent<ImageQualityWorkerResponse>,
        ): void => {
            const data = event.data;
            if (data.id !== requestId) {
                return;
            }
            worker.removeEventListener("message", handleMessage);
            if (data.error !== undefined || data.score === undefined) {
                reject(new Error(data.error ?? "Quality score failed"));
                return;
            }
            resolve(data.score);
        };

        worker.addEventListener("message", handleMessage);
        const request: ImageQualityWorkerRequest = {
            id: requestId,
            fileId,
            bytes: bytes.slice(),
            originalWidth,
            originalHeight,
            fileBytes,
        };
        worker.postMessage(request, [request.bytes.buffer]);
    });

/**
 * Load the encrypted quality index, or an empty map when missing/stale.
 *
 * [Note: quality index version] Scores are discarded when
 * `persisted.version !== QUALITY_INDEX_VERSION` so formula changes force a
 * Manage → Settings rescan rather than ranking with incompatible numbers.
 */
export const hydrateQualityIndex = async (): Promise<Map<number, number>> => {
    const persisted = await loadEncryptedQualityIndex(getSessionCacheKey());
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

export const clearPersistedQualityIndex = async (): Promise<void> => {
    await saveEncryptedQualityIndex(emptyIndex(), getSessionCacheKey());
};

/** Write the index every N scores so progress survives interruption. */
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
    const candidates = imageFilesForPhash([...options.files], options.userId)
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

export const terminateImageQualityWorker = (): void => {
    workers?.forEach((worker) => {
        worker.terminate();
    });
    workers = undefined;
    workerRoundRobin = 0;
};
