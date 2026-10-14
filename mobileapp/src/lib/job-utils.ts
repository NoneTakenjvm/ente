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

/**
 * Whole percent (0-100) of `current` out of `total`. `ratio` (0-1) is how far
 * through the item numbered `current` (1-based) the job is.
 */
export const jobPercent = (
    current: number,
    total: number,
    ratio?: number,
): number => {
    if (total <= 0) {
        return 0;
    }
    const done = ratio === undefined ? current : current - 1 + ratio;
    return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
};
