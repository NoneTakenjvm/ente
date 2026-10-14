import { useCallback, useMemo, type JSX } from "react";
import { Crop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getEnteCore } from "@/core";
import { mapBatched } from "@/lib/batched";
import { clampCropRect, encodeCroppedJpeg } from "@/lib/crop";
import {
    confirmDiscardPendingCrops,
    countPendingCrops,
    normalizedToPixelRect,
    type PendingCrop,
} from "@/lib/crop-draft";
import { getLocalMediaOverride } from "@/lib/local-media-overrides";
import { useLibraryStore } from "@/stores/library-store";
import { useSelectionStore } from "@/stores/selection-store";
import { toast } from "sonner";
import { plural } from "@/lib/format";

const APPLY_CONCURRENCY = 2;

/**
 * Footer for quick-crop mode: draft crop boxes, then Apply crops a few at a time.
 */
export function CropToolFooter(): JSX.Element | null {
    const cropActive = useSelectionStore((s) => s.cropActive);
    const pendingCrops = useSelectionStore((s) => s.pendingCrops);
    const setCropActive = useSelectionStore((s) => s.setCropActive);
    const clearPendingCrops = useSelectionStore((s) => s.clearPendingCrops);
    const removePendingCrop = useSelectionStore((s) => s.removePendingCrop);
    const setCropBusy = useSelectionStore((s) => s.setCropBusy);
    const cropBusy = useSelectionStore((s) => s.cropBusy);

    const pendingCount = useMemo(
        () => countPendingCrops(pendingCrops),
        [pendingCrops],
    );

    const pendingEntries = useMemo(
        () =>
            Object.entries(pendingCrops).map(([id, pending]) => ({
                fileId: Number(id),
                pending,
            })),
        [pendingCrops],
    );

    const exitCrop = useCallback((): void => {
        if (cropBusy) {
            return;
        }
        if (!confirmDiscardPendingCrops(pendingCrops)) {
            return;
        }
        setCropActive(false);
    }, [cropBusy, pendingCrops, setCropActive]);

    const handleDiscard = useCallback((): void => {
        if (cropBusy) {
            return;
        }
        clearPendingCrops();
    }, [clearPendingCrops, cropBusy]);

    const handleApply = useCallback(async (): Promise<void> => {
        if (cropBusy || pendingEntries.length === 0) {
            return;
        }
        setCropBusy(true);
        const total = pendingEntries.length;
        let done = 0;
        let failed = 0;
        const progress = toast.loading(`Cropping 0 of ${total}…`);
        try {
            // A few files in flight overlaps download, encode and upload while
            // still bounding the image and undo-history bytes held in memory.
            await mapBatched(
                pendingEntries,
                async (entry) => {
                    try {
                        const { finalize } = await cropFile(
                            entry.fileId,
                            entry.pending,
                        );
                        // Committed and queued for retry: re-applying would crop twice.
                        removePendingCrop(entry.fileId);
                        done += 1;
                        toast.loading(`Cropping ${done} of ${total}…`, {
                            id: progress,
                        });
                        await finalize.catch(() => undefined);
                    } catch (error) {
                        failed += 1;
                        console.warn("Quick crop failed", entry.fileId, error);
                    }
                },
                { concurrency: APPLY_CONCURRENCY },
            );
            if (failed === 0) {
                toast.success(
                    `Cropped ${plural(done, "photo")}`,
                    { id: progress },
                );
                setCropActive(false);
            } else {
                toast.error(
                    `Cropped ${done}, ${failed} failed — retry remaining`,
                    { id: progress },
                );
            }
        } finally {
            setCropBusy(false);
        }
    }, [
        cropBusy,
        pendingEntries,
        removePendingCrop,
        setCropActive,
        setCropBusy,
    ]);

    if (!cropActive) {
        return null;
    }

    return (
        <footer className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 border-t border-border bg-background/95 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur">
            <div className="flex items-center justify-between gap-2">
                <p className="flex min-w-0 items-center gap-1.5 truncate text-sm text-muted-foreground">
                    <Crop className="size-3.5 shrink-0" />
                    <span className="truncate">
                        {pendingCount === 0 ?
                            "Tap photos to add a crop box" :
                            `${pendingCount} pending · drag to adjust`}
                    </span>
                </p>
                <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={cropBusy || pendingCount === 0}
                        onClick={handleDiscard}
                    >
                        Discard
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={cropBusy}
                        onClick={exitCrop}
                    >
                        Close
                    </Button>
                    <Button
                        type="button"
                        variant="default"
                        size="sm"
                        disabled={cropBusy || pendingCount === 0}
                        onClick={() => {
                            void handleApply();
                        }}
                    >
                        {cropBusy ? <Spinner className="size-3.5" /> : null}
                        Apply
                    </Button>
                </div>
            </div>
        </footer>
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
    const { allFiles, cropAndReplaceFileOptimistic } =
        useLibraryStore.getState();
    const file = allFiles.find((entry) => entry.id === fileId);
    if (!file) {
        throw new Error(`File ${fileId} not found`);
    }
    const bytes =
        getLocalMediaOverride(fileId) ??
        (await getEnteCore().getDecryptedFile(file));
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
