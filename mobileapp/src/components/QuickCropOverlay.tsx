import type { JSX } from "react";
import { X } from "lucide-react";
import { CropBox } from "@/components/CropBox";
import { containedBox, type PendingCrop } from "@/lib/crop-draft";
import { useSelectionStore } from "@/stores/selection-store";

interface QuickCropOverlayProps {
    fileId: number;
    crop: PendingCrop;
    cellWidth: number;
    cellHeight: number;
    disabled?: boolean;
}

/**
 * Draft crop box drawn over a thumbnail tile: drag inside to move, drag a
 * corner to resize, × to remove. The store is written once per drag, on
 * release.
 */
export function QuickCropOverlay({
    fileId,
    crop,
    cellWidth,
    cellHeight,
    disabled = false,
}: QuickCropOverlayProps): JSX.Element {
    const setPendingCropRect = useSelectionStore((s) => s.setPendingCropRect);
    const removePendingCrop = useSelectionStore((s) => s.removePendingCrop);

    return (
        <CropBox
            imageBox={containedBox(crop.imageAspect, cellWidth, cellHeight)}
            rect={crop.rect}
            onCommit={(rect) => {
                setPendingCropRect(fileId, rect);
            }}
            disabled={disabled}
        >
            {disabled ? null : (
                <button
                    type="button"
                    className="absolute top-1 left-1/2 z-10 flex size-7 -translate-x-1/2 items-center justify-center rounded-full bg-black/70 text-white"
                    aria-label="Remove crop"
                    onPointerDown={(event) => {
                        event.stopPropagation();
                    }}
                    onClick={() => {
                        removePendingCrop(fileId);
                    }}
                >
                    <X className="size-4" aria-hidden />
                </button>
            )}
        </CropBox>
    );
}
