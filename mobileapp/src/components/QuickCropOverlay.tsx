import {
    useRef,
    useState,
    type JSX,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { X } from "lucide-react";
import {
    containedBox,
    dragCropRect,
    type CropDragHandle,
    type NormalizedCropRect,
    type PendingCrop,
} from "@/lib/crop-draft";
import { cn } from "@/lib/utils";
import { useSelectionStore } from "@/stores/selection-store";

/** Smallest crop box edge, in CSS px. */
const MIN_CROP_EDGE_PX = 32;

/** Corner handles: 32px touch target, offset outward so most of it stays inside the box. */
const CORNER_HANDLES = [
    {
        handle: "nw",
        hitClass: "-left-2 -top-2 cursor-nwse-resize",
        markClass: "left-2.5 top-2.5 border-l-2 border-t-2",
    },
    {
        handle: "ne",
        hitClass: "-right-2 -top-2 cursor-nesw-resize",
        markClass: "right-2.5 top-2.5 border-r-2 border-t-2",
    },
    {
        handle: "sw",
        hitClass: "-bottom-2 -left-2 cursor-nesw-resize",
        markClass: "bottom-2.5 left-2.5 border-b-2 border-l-2",
    },
    {
        handle: "se",
        hitClass: "-bottom-2 -right-2 cursor-nwse-resize",
        markClass: "bottom-2.5 right-2.5 border-b-2 border-r-2",
    },
] as const;

interface QuickCropOverlayProps {
    fileId: number;
    crop: PendingCrop;
    cellWidth: number;
    cellHeight: number;
    disabled?: boolean;
}

interface ActiveDrag {
    handle: CropDragHandle;
    startX: number;
    startY: number;
    startRect: NormalizedCropRect;
    latestRect: NormalizedCropRect;
}

/**
 * Draft crop box drawn over a thumbnail tile: drag inside to move, drag a
 * corner to resize, × to remove. Only the box itself takes pointer events, so
 * everything outside it still scrolls the grid. The store is written once per
 * drag, on release.
 */
export function QuickCropOverlay({
    fileId,
    crop,
    cellWidth,
    cellHeight,
    disabled = false,
}: QuickCropOverlayProps): JSX.Element | null {
    const setPendingCropRect = useSelectionStore((s) => s.setPendingCropRect);
    const removePendingCrop = useSelectionStore((s) => s.removePendingCrop);
    const [dragRect, setDragRect] = useState<NormalizedCropRect | undefined>();
    const dragRef = useRef<ActiveDrag | undefined>(undefined);

    const box = containedBox(crop.imageAspect, cellWidth, cellHeight);
    if (box.width <= 0 || box.height <= 0) {
        return null;
    }
    const rect = dragRect ?? crop.rect;

    const beginDrag = (
        event: ReactPointerEvent<HTMLElement>,
        handle: CropDragHandle,
    ): void => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
            handle,
            startX: event.clientX,
            startY: event.clientY,
            startRect: crop.rect,
            latestRect: crop.rect,
        };
    };

    const moveDrag = (event: ReactPointerEvent<HTMLElement>): void => {
        const drag = dragRef.current;
        if (!drag) {
            return;
        }
        drag.latestRect = dragCropRect(
            drag.startRect,
            drag.handle,
            (event.clientX - drag.startX) / box.width,
            (event.clientY - drag.startY) / box.height,
            MIN_CROP_EDGE_PX / box.width,
            MIN_CROP_EDGE_PX / box.height,
        );
        setDragRect(drag.latestRect);
    };

    const endDrag = (): void => {
        const drag = dragRef.current;
        if (!drag) {
            return;
        }
        dragRef.current = undefined;
        setPendingCropRect(fileId, drag.latestRect);
        setDragRect(undefined);
    };

    const dragProps = (handle: CropDragHandle): object => ({
        onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
            beginDrag(event, handle);
        },
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
    });

    return (
        <div
            className="pointer-events-none absolute z-20"
            style={{
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
            }}
        >
            <div
                className={cn(
                    "absolute border border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]",
                    disabled ? "pointer-events-none" : "pointer-events-auto",
                )}
                style={{
                    left: `${rect.x * 100}%`,
                    top: `${rect.y * 100}%`,
                    width: `${rect.width * 100}%`,
                    height: `${rect.height * 100}%`,
                    touchAction: "none",
                }}
                {...dragProps("move")}
            >
                {CORNER_HANDLES.map(({ handle, hitClass, markClass }) => (
                    <span
                        key={handle}
                        className={cn("absolute size-8", hitClass)}
                        {...dragProps(handle)}
                    >
                        <span
                            className={cn(
                                "pointer-events-none absolute size-4 border-white",
                                markClass,
                            )}
                            aria-hidden
                        />
                    </span>
                ))}
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
            </div>
        </div>
    );
}
