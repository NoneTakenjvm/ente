import { useCallback, useMemo, type JSX } from "react";
import { Crop } from "lucide-react";
import { PendingBatchFooter } from "@/components/PendingBatchFooter";
import { clampCropRect, encodeCroppedJpeg } from "@/lib/crop";
import {
    confirmDiscardPendingCrops,
    normalizedToPixelRect,
    type PendingCrop,
} from "@/lib/crop-draft";
import { loadMediaBytesForEdit } from "@/lib/load-media-bytes";
import { useLibraryStore } from "@/stores/library-store";
import { useSelectionStore } from "@/stores/selection-store";

const APPLY_CONCURRENCY = 2;
const VERB = { active: "Cropping", past: "Cropped" };

interface PendingCropEntry {
    fileId: number;
    pending: PendingCrop;
}

/**
 * Footer for quick-crop mode: draft crop boxes, then Apply crops a few at a time.
 * A few files in flight overlaps download, encode and upload while still
 * bounding the image and undo-history bytes held in memory.
 */
export function CropToolFooter(): JSX.Element | null {
    const pendingCrops = useSelectionStore((s) => s.pendingCrops);
    const clearPendingCrops = useSelectionStore((s) => s.clearPendingCrops);
    const removePendingCrop = useSelectionStore((s) => s.removePendingCrop);

    const entries = useMemo(
        (): PendingCropEntry[] =>
            Object.entries(pendingCrops).map(([id, pending]) => ({
                fileId: Number(id),
                pending,
            })),
        [pendingCrops],
    );

    const applyOne = useCallback(
        async (entry: PendingCropEntry): Promise<{ finalize: Promise<unknown> }> => {
            const result = await cropFile(entry.fileId, entry.pending);
            // Committed and queued for retry: re-applying would crop twice.
            removePendingCrop(entry.fileId);
            return result;
        },
        [removePendingCrop],
    );

    const confirmDiscard = useCallback(
        (): boolean => confirmDiscardPendingCrops(pendingCrops),
        [pendingCrops],
    );

    return (
        <PendingBatchFooter
            mode="crop"
            icon={<Crop className="size-3.5 shrink-0" />}
            emptyHint="Tap photos to add a crop box"
            pendingHint="drag to adjust"
            verb={VERB}
            entries={entries}
            applyOne={applyOne}
            concurrency={APPLY_CONCURRENCY}
            confirmDiscard={confirmDiscard}
            clearPending={clearPendingCrops}
        />
    );
}

/**
 * Decode, crop and encode one file, then commit the optimistic replace.
 * Rejects before anything is committed; `finalize` settles when the replace
 * upload finishes. Returned in an object so awaiting this does not wait for it.
 */
const cropFile = async (
    fileId: number,
    pending: PendingCrop,
): Promise<{ finalize: Promise<unknown> }> => {
    const { getFileById, cropAndReplaceFileOptimistic } =
        useLibraryStore.getState();
    const file = getFileById(fileId);
    if (!file) {
        throw new Error(`File ${fileId} not found`);
    }
    const bytes = await loadMediaBytesForEdit(file);
    const { toRenderableImageBlob } = await import("@/lib/renderable-image");
    const blob = await toRenderableImageBlob(file, bytes);
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    bitmap.close();
    const encoded = await encodeCroppedJpeg(
        new Uint8Array(await blob.arrayBuffer()),
        clampCropRect(
            normalizedToPixelRect(pending.rect, width, height),
            width,
            height,
        ),
    );
    return cropAndReplaceFileOptimistic(
        fileId,
        encoded.bytes,
        { width: encoded.width, height: encoded.height },
        { sourceBytes: bytes },
    );
};
