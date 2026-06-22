import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import {
    loadEncryptedPhashIndex,
    saveEncryptedPhashIndex,
    type PersistedPhashIndex,
} from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";
import {
    getDecryptedThumbnailBytes,
    isThumbnailCachedLocally,
} from "@/lib/thumbnail-bytes";
import type {
    PhashWorkerRequest,
    PhashWorkerResponse,
} from "@/workers/phash-worker-types";

export interface PhashJobOptions {
    files: EnteFile[];
    entries: Map<number, string>;
    onProgress?: (current: number, total: number) => void;
    shouldPause?: () => boolean;
    signal?: AbortSignal;
}

const emptyIndex = (): PersistedPhashIndex => ({
    version: 1,
    entries: {},
});

const indexFromMap = (entries: Map<number, string>): PersistedPhashIndex => ({
    version: 1,
    entries: Object.fromEntries(entries.entries()),
});

const persistIndex = async (entries: Map<number, string>): Promise<void> => {
    await saveEncryptedPhashIndex(
        indexFromMap(entries),
        getSessionCacheKey(),
    );
};

let worker: Worker | undefined;
let requestCounter = 0;

const getPhashWorker = (): Worker => {
    if (!worker) {
        worker = new Worker(
            new URL("../workers/phash.worker.ts", import.meta.url),
        );
    }
    return worker;
};

const hashBytesInWorker = (
    fileId: number,
    bytes: Uint8Array,
): Promise<string> =>
    new Promise((resolve, reject) => {
        const phashWorker = getPhashWorker();
        const requestId = ++requestCounter;

        const handleMessage = (event: MessageEvent<PhashWorkerResponse>): void => {
            if (event.data.id !== requestId) {
                return;
            }
            phashWorker.removeEventListener("message", handleMessage);
            if (event.data.error || !event.data.hash) {
                reject(new Error(event.data.error ?? "Hash failed"));
                return;
            }
            resolve(event.data.hash);
        };

        phashWorker.addEventListener("message", handleMessage);
        const request: PhashWorkerRequest = {
            id: requestId,
            fileId,
            bytes: bytes.slice(),
        };
        phashWorker.postMessage(request, [request.bytes.buffer]);
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

export const hydratePhashIndex = async (): Promise<Map<number, string>> => {
    const persisted = await loadEncryptedPhashIndex(getSessionCacheKey());
    if (!persisted) {
        return new Map();
    }
    return new Map(
        Object.entries(persisted.entries).map(([fileId, hash]) => [
            Number(fileId),
            hash,
        ]),
    );
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
        { version: 1, entries: nextEntries },
        getSessionCacheKey(),
    );
};

const chunkSize = 16;
const cachedFetchConcurrency = 12;
const networkFetchConcurrency = 4;
const hashConcurrency = 3;

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
 * Compute dHash for image files missing from the index; persist incrementally.
 */
export const runPhashJob = async (
    options: PhashJobOptions,
): Promise<Map<number, string>> => {
    const candidates = options.files
        .filter((file) => !options.entries.has(file.id))
        .sort((a, b) => a.id - b.id);

    const total = candidates.length;
    let completed = 0;
    const entries = new Map(options.entries);

    for (let offset = 0; offset < candidates.length; offset += chunkSize) {
        if (options.signal?.aborted) {
            break;
        }
        if (await waitIfPaused(options.shouldPause, options.signal)) {
            break;
        }

        const chunk = candidates.slice(offset, offset + chunkSize);
        const bytesByFileId = new Map<number, Uint8Array>();

        const cacheStatus = await Promise.all(
            chunk.map(async (file) => ({
                file,
                cached: await isThumbnailCachedLocally(file.id),
            })),
        );
        const cachedFiles = cacheStatus
            .filter((entry) => entry.cached)
            .map((entry) => entry.file);
        const networkFiles = cacheStatus
            .filter((entry) => !entry.cached)
            .map((entry) => entry.file);

        await runWithConcurrency(cachedFiles, cachedFetchConcurrency, async (file) => {
            const bytes = await getDecryptedThumbnailBytes(file);
            if (bytes) {
                bytesByFileId.set(file.id, bytes);
            }
        });
        await runWithConcurrency(networkFiles, networkFetchConcurrency, async (file) => {
            const bytes = await getDecryptedThumbnailBytes(file);
            if (bytes) {
                bytesByFileId.set(file.id, bytes);
            }
        });

        const hashTargets = chunk.filter((file) => bytesByFileId.has(file.id));
        await runWithConcurrency(hashTargets, hashConcurrency, async (file) => {
            if (options.signal?.aborted) {
                return;
            }
            const bytes = bytesByFileId.get(file.id);
            if (!bytes) {
                return;
            }
            try {
                const hash = await hashBytesInWorker(file.id, bytes);
                entries.set(file.id, hash);
            } catch {
                // Skip files we cannot hash.
            }
        });

        completed += chunk.length;
        options.onProgress?.(completed, total);

        await persistIndex(entries);
    }

    return entries;
};

export const terminatePhashWorker = (): void => {
    worker?.terminate();
    worker = undefined;
};
