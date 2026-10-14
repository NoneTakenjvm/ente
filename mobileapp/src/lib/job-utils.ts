import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";

/** Worker pool size for CPU-bound scans: 2 to 8, following the core count. */
export const workerCount = (): number => {
    if (typeof navigator === "undefined") {
        return 4;
    }
    return Math.min(8, Math.max(2, navigator.hardwareConcurrency ?? 4));
};

/**
 * Owned still images only. Used for dHash scan, quality scan and CLIP embed —
 * videos and archived files are excluded (archived = long-term storage, not
 * active gallery).
 */
export const eligibleImageFiles = (
    files: readonly EnteFile[],
    userId: number,
): EnteFile[] =>
    files.filter(
        (file) =>
            file.ownerID === userId &&
            file.metadata.fileType === FileType.image &&
            !isFileArchivedLocally(file),
    );

/** Run `worker` over `items` with at most `limit` calls in flight. */
export const runWithConcurrency = async <T>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<void>,
): Promise<void> => {
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
 * Wait while `shouldPause` is true, polling every 200 ms.
 *
 * @returns `true` if the job should stop because `signal` is aborted.
 */
export const waitIfPaused = async (
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
 * Wrap `emit` so calls closer together than `minIntervalMs` are dropped.
 * The first call always emits, and `force` bypasses the throttle (use it for
 * the final update).
 */
export const progressReporter = (
    minIntervalMs: number,
    emit: () => void,
): ((force?: boolean) => void) => {
    let lastEmitAt = -Infinity;
    return (force = false): void => {
        const now = performance.now();
        if (!force && now - lastEmitAt < minIntervalMs) {
            return;
        }
        lastEmitAt = now;
        emit();
    };
};
