import type { EnteFile } from "ente-media/file";
import { getEnteCore } from "@/core";
import { mapBatched } from "@/lib/batched";
import {
    AUTO_CROPPED_TAG,
    canAutoCrop,
    encodeCroppedJpeg,
} from "@/lib/crop";
import {
    detectContentBoundsFromBytes,
    hasMeaningfulBorder,
} from "@/lib/crop-editor";
import {
    terminateBorderScanWorker,
    thumbHasBorderInWorker,
} from "@/lib/border-scan-job";
import { getLocalMediaOverride } from "@/lib/local-media-overrides";
import { mimeTypeForFile } from "@/lib/media-kind";
import { isJsHeapUnderPressure, logJsHeap } from "@/lib/memory-probe";
import { addTagNames } from "@/lib/tag-writes";
import { loadDecryptedThumbnailBytes } from "@/lib/thumbnail-cache";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import { useLibraryStore } from "@/stores/library-store";

/**
 * Cap each auto-crop run. Lower than the UI "up to 100" aspiration when the
 * heap is under pressure — phone Chrome dies long before 100 full decrypts.
 */
export const AUTO_CROP_BATCH_SIZE = 100;
export const AUTO_CROP_BATCH_SIZE_UNDER_PRESSURE = 20;

const THUMB_CONCURRENCY = 1;
const APPLY_CONCURRENCY = 1;

export interface AutoCropProgress {
    current: number;
    total: number;
    /** What the job is doing, shown before the count. */
    label: string;
}

export interface AutoCropScanResult {
    /** Files whose thumbnail looks letterboxed. */
    found: EnteFile[];
    message: string;
}

/** Images still eligible for auto-crop (not archived, not yet marked). */
export const autoCropEligibleFiles = (files: EnteFile[]): EnteFile[] =>
    files.filter((file) => canAutoCrop(file) && !isFileArchivedLocally(file));

/**
 * Scan up to {@link AUTO_CROP_BATCH_SIZE} eligible images' thumbnails for
 * black borders. Images without a border are marked with the hidden
 * `auto-cropped` tag so later runs skip them.
 */
export const runAutoCropScan = async (
    files: EnteFile[],
    signal: AbortSignal,
    onProgress: (progress: AutoCropProgress) => void,
): Promise<AutoCropScanResult> => {
    const eligible = autoCropEligibleFiles(files);
    const underPressure = isJsHeapUnderPressure();
    const batchSize = underPressure ?
        AUTO_CROP_BATCH_SIZE_UNDER_PRESSURE :
        AUTO_CROP_BATCH_SIZE;
    const remaining = Math.max(0, eligible.length - batchSize);
    const croppable = eligible.slice(0, batchSize);
    logJsHeap(
        underPressure ?
            "auto-crop:scan-start(pressure)" :
            "auto-crop:scan-start",
    );

    const label =
        remaining > 0 ?
            `Scanning batch of ${croppable.length} (${remaining} more later)…` :
            "Loading thumbnails and scanning…";
    onProgress({ current: 0, total: croppable.length, label });
    const likelyIds: number[] = [];
    let thumbDone = 0;
    let fetchedThumbs = 0;
    let markedClean = 0;
    let failedThumbs = 0;
    let lastProgressAt = 0;

    try {
        await mapBatched(
            croppable,
            async (file) => {
                if (signal.aborted) {
                    return;
                }
                try {
                    const thumbBytes = await loadDecryptedThumbnailBytes(file);
                    fetchedThumbs += 1;
                    if (signal.aborted) {
                        return;
                    }
                    const hasBorder = await thumbHasBorderInWorker(
                        file.id,
                        thumbBytes,
                    );
                    if (hasBorder) {
                        likelyIds.push(file.id);
                    } else {
                        await markAutoCropped(file);
                        markedClean += 1;
                    }
                } catch {
                    failedThumbs += 1;
                } finally {
                    thumbDone += 1;
                    const now = Date.now();
                    if (
                        thumbDone === croppable.length ||
                        now - lastProgressAt >= 200
                    ) {
                        lastProgressAt = now;
                        onProgress({
                            current: thumbDone,
                            total: croppable.length,
                            label,
                        });
                    }
                    if (thumbDone % 4 === 0) {
                        await yieldToMain();
                    }
                }
            },
            { concurrency: THUMB_CONCURRENCY },
        );
    } finally {
        terminateBorderScanWorker();
    }

    const fileById = new Map(croppable.map((file) => [file.id, file] as const));
    const found: EnteFile[] = likelyIds
        .map((id) => fileById.get(id))
        .filter((file): file is EnteFile => file !== undefined);

    logJsHeap("auto-crop:scan-done");
    const batchNote =
        remaining > 0 ?
            ` ${remaining} eligible left for later runs.` :
            "";
    const pressureNote = underPressure ?
        " (smaller batch - memory pressure)." :
        "";
    const cleanNote =
        markedClean > 0 ?
            ` Marked ${markedClean} without borders as done.` :
            "";
    const failNote =
        failedThumbs > 0 ?
            ` ${failedThumbs} thumbs failed (will retry next run).` :
            "";
    const message = found.length ?
        `Found ${found.length} likely letterboxed. Crop verifies each at full resolution.${cleanNote}${failNote}${batchNote}${pressureNote}` :
        `No letterboxed images in this batch of ${fetchedThumbs}.${cleanNote}${failNote}${batchNote}${pressureNote}`;
    return { found, message };
};

/**
 * Crop each of {@link candidates} at full resolution, marking those that turn
 * out to have no meaningful border.
 *
 * @returns the summary message to show the user.
 */
export const runAutoCropApply = async (
    candidates: EnteFile[],
    signal: AbortSignal,
    onProgress: (progress: AutoCropProgress) => void,
): Promise<string> => {
    const { cropAndReplaceFileOptimistic } = useLibraryStore.getState();
    onProgress({ current: 0, total: candidates.length, label: "" });
    logJsHeap("auto-crop:apply-start");
    let cropped = 0;
    let marked = 0;
    let completed = 0;
    try {
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
                    const detected = await detectContentBoundsFromBytes(
                        bytes,
                        mimeTypeForFile(file),
                    );
                    if (
                        !detected ||
                        !hasMeaningfulBorder(
                            detected.bounds,
                            detected.width,
                            detected.height,
                        )
                    ) {
                        await markAutoCropped(file);
                        marked += 1;
                        return;
                    }
                    const encoded = await encodeCroppedJpeg(
                        bytes,
                        detected.bounds,
                    );
                    const { finalize } = cropAndReplaceFileOptimistic(
                        file.id,
                        encoded.bytes,
                        {
                            width: encoded.width,
                            height: encoded.height,
                        },
                        { autoCropped: true, sourceBytes: bytes },
                    );
                    void finalize.catch(() => {
                        // Store path handles revert/toast.
                    });
                    cropped += 1;
                } catch {
                    // Continue batch.
                } finally {
                    completed += 1;
                    onProgress({
                        current: completed,
                        total: candidates.length,
                        label: "",
                    });
                    await yieldToMain();
                }
            },
            { concurrency: APPLY_CONCURRENCY },
        );
    } finally {
        terminateBorderScanWorker();
    }
    logJsHeap("auto-crop:apply-done");
    return `Cropped ${cropped}, marked ${marked} without borders (${candidates.length} in this batch).`;
};

const markAutoCropped = async (file: EnteFile): Promise<void> => {
    await useLibraryStore
        .getState()
        .updateTagsOnFile(file.id, (tags) => addTagNames(tags, AUTO_CROPPED_TAG));
};

const yieldToMain = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
