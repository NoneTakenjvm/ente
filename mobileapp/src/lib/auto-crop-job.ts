import type { EnteFile } from "ente-media/file";
import { batch } from "ente-utils/array";
import { getEnteCore } from "@/core";
import { mapBatched } from "@/lib/batched";
import {
    terminateBorderScanWorker,
    thumbHasBorderInWorker,
} from "@/lib/border-scan-job";
import { autoCropJpegInWorker } from "@/lib/compress";
import { AUTO_CROPPED_TAG, canAutoCrop } from "@/lib/crop";
import { getLocalMediaOverride } from "@/lib/local-media-overrides";
import { isJsHeapUnderPressure, logJsHeap } from "@/lib/memory-probe";
import { addTagNames } from "@/lib/tag-writes";
import { loadDecryptedThumbnailBytes } from "@/lib/thumbnail-cache";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import { useLibraryStore } from "@/stores/library-store";

export interface AutoCropProgress {
    /** Eligible images finished (clean, cropped or failed). */
    current: number;
    total: number;
    /** What the job is doing, shown before the count. */
    label: string;
    cropped: number;
}

interface AutoCropTotals {
    cropped: number;
    clean: number;
    failed: number;
}

/** Images scanned (then cropped) per batch. */
export const AUTO_CROP_BATCH_SIZE = 100;
/** Thumbnail loads are mostly network-bound, so several run at once. */
const SCAN_CONCURRENCY = 4;
/** Two full-size images in flight overlap one's download with the other's encode. */
const CROP_CONCURRENCY = 2;
/** Crops awaiting upload hold their bytes in memory; past this the job waits. */
const MAX_PENDING_UPLOADS = 3;
const PROGRESS_INTERVAL_MS = 200;

/** Images still eligible for auto-crop (not archived, not yet marked). */
export const autoCropEligibleFiles = (files: EnteFile[]): EnteFile[] =>
    files.filter((file) => canAutoCrop(file) && !isFileArchivedLocally(file));

/**
 * Auto-crop every eligible image, {@link AUTO_CROP_BATCH_SIZE} at a time,
 * until all are done or {@link signal} aborts. Each batch scans thumbnails for
 * black borders, then crops the likely ones at full resolution and waits for
 * their uploads. Images without a border get the hidden `auto-cropped` tag so
 * later runs skip them; failures are left for the next run.
 *
 * @returns the summary message to show the user.
 */
export const runAutoCrop = async (
    files: EnteFile[],
    signal: AbortSignal,
    onProgress: (progress: AutoCropProgress) => void,
): Promise<string> => {
    const eligible = autoCropEligibleFiles(files);
    const batches = batch(eligible, AUTO_CROP_BATCH_SIZE);
    const totals: AutoCropTotals = { cropped: 0, clean: 0, failed: 0 };
    let finished = 0;
    let label = "";
    let lastProgressAt = 0;
    const report = (): void => {
        onProgress({
            current: finished,
            total: eligible.length,
            label,
            cropped: totals.cropped,
        });
    };
    const onFileDone = (): void => {
        finished += 1;
        const now = Date.now();
        if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
            lastProgressAt = now;
            report();
        }
    };

    logJsHeap("auto-crop:start");
    try {
        for (const [index, batchFiles] of batches.entries()) {
            if (signal.aborted) {
                break;
            }
            const batchNote = `(batch ${index + 1} of ${batches.length})`;
            label = `Scanning ${batchNote}`;
            report();
            const candidates = await scanBatch(
                batchFiles,
                signal,
                totals,
                onFileDone,
            );
            label = `Cropping ${batchNote}`;
            report();
            await cropBatch(candidates, signal, totals, onFileDone);
        }
    } finally {
        terminateBorderScanWorker();
    }
    logJsHeap("auto-crop:done");

    const failNote =
        totals.failed > 0 ?
            ` ${totals.failed} failed (retried next run).` :
            "";
    const stopNote = signal.aborted ?
        ` Stopped after ${finished} of ${eligible.length}.` :
        "";
    return `Cropped ${totals.cropped}, ${totals.clean} had no border.${failNote}${stopNote}`;
};

/**
 * Check each file's thumbnail for a border. Marks clean files done and returns
 * the likely letterboxed ones (counted as done once cropped).
 */
const scanBatch = async (
    files: EnteFile[],
    signal: AbortSignal,
    totals: AutoCropTotals,
    onFileDone: () => void,
): Promise<EnteFile[]> => {
    const candidates: EnteFile[] = [];
    await mapBatched(
        files,
        async (file) => {
            if (signal.aborted) {
                return;
            }
            try {
                const thumbBytes = await loadDecryptedThumbnailBytes(file);
                if (await thumbHasBorderInWorker(file.id, thumbBytes)) {
                    candidates.push(file);
                    return;
                }
                await markAutoCropped(file);
                totals.clean += 1;
            } catch {
                totals.failed += 1;
            }
            onFileDone();
        },
        { concurrency: SCAN_CONCURRENCY },
    );
    return candidates;
};

/**
 * Crop each candidate at full resolution (the thumbnail check has false
 * positives, so files without a real border are marked clean instead).
 */
const cropBatch = async (
    candidates: EnteFile[],
    signal: AbortSignal,
    totals: AutoCropTotals,
    onFileDone: () => void,
): Promise<void> => {
    const { cropAndReplaceFileOptimistic } = useLibraryStore.getState();
    const uploads = new Set<Promise<void>>();
    await mapBatched(
        candidates,
        async (file) => {
            if (signal.aborted) {
                return;
            }
            try {
                const bytes =
                    getLocalMediaOverride(file.id) ??
                    (await getEnteCore().getDecryptedFile(file));
                const cropped = await autoCropJpegInWorker(bytes);
                if (!cropped) {
                    await markAutoCropped(file);
                    totals.clean += 1;
                } else {
                    const { finalize } = cropAndReplaceFileOptimistic(
                        file.id,
                        cropped.bytes,
                        { width: cropped.width, height: cropped.height },
                        { autoCropped: true },
                    );
                    totals.cropped += 1;
                    // The store reverts and toasts a failed upload.
                    const upload: Promise<void> = finalize
                        .then(() => undefined, () => undefined)
                        .finally(() => uploads.delete(upload));
                    uploads.add(upload);
                    while (uploads.size >= MAX_PENDING_UPLOADS) {
                        await Promise.race(uploads);
                    }
                }
            } catch {
                totals.failed += 1;
            }
            onFileDone();
        },
        {
            concurrency: isJsHeapUnderPressure() ? 1 : CROP_CONCURRENCY,
        },
    );
    if (!signal.aborted) {
        await Promise.all(uploads);
    }
};

const markAutoCropped = async (file: EnteFile): Promise<void> => {
    await useLibraryStore
        .getState()
        .updateTagsOnFile(file.id, (tags) => addTagNames(tags, AUTO_CROPPED_TAG));
};
