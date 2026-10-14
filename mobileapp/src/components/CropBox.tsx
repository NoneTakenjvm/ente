import {
    useRef,
    useState,
    type JSX,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from "react";
import {
    dragCropRect,
    type ContainedBox,
    type CropDragHandle,
    type NormalizedCropRect,
} from "@/lib/crop-draft";
import { cn } from "@/lib/utils";

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

/** Edge handles: 24px strips between the corner targets. */
const EDGE_HANDLES = [
    { handle: "n", hitClass: "inset-x-8 -top-3 h-6 cursor-ns-resize" },
    { handle: "s", hitClass: "inset-x-8 -bottom-3 h-6 cursor-ns-resize" },
    { handle: "w", hitClass: "inset-y-8 -left-3 w-6 cursor-ew-resize" },
    { handle: "e", hitClass: "inset-y-8 -right-3 w-6 cursor-ew-resize" },
] as const;

interface CropBoxProps {
    /** Where the image sits in the positioned parent, in CSS px. */
    imageBox: ContainedBox;
    rect: NormalizedCropRect;
    /** Called once per drag, on release. */
    onCommit: (rect: NormalizedCropRect) => void;
    disabled?: boolean;
    /** Normalized width / height that resizes keep, when set. */
    lockedRatio?: number;
    edgeHandles?: boolean;
    /** Extra controls drawn inside the box. */
    children?: ReactNode;
}

interface ActiveDrag {
    handle: CropDragHandle;
    startX: number;
    startY: number;
    startRect: NormalizedCropRect;
    latestRect: NormalizedCropRect;
}

/**
 * Crop box over an image: drag inside to move, drag a corner (or edge) to
 * resize. Only the box itself takes pointer events, so everything outside it
 * still scrolls. Place it inside a positioned parent.
 */
export function CropBox({
    imageBox,
    rect,
    onCommit,
    disabled = false,
    lockedRatio,
    edgeHandles = false,
    children,
}: CropBoxProps): JSX.Element | null {
    const [dragRect, setDragRect] = useState<NormalizedCropRect | undefined>();
    const dragRef = useRef<ActiveDrag | undefined>(undefined);

    if (imageBox.width <= 0 || imageBox.height <= 0) {
        return null;
    }
    const shownRect = dragRect ?? rect;

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
            startRect: rect,
            latestRect: rect,
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
            (event.clientX - drag.startX) / imageBox.width,
            (event.clientY - drag.startY) / imageBox.height,
            MIN_CROP_EDGE_PX / imageBox.width,
            MIN_CROP_EDGE_PX / imageBox.height,
            lockedRatio,
        );
        setDragRect(drag.latestRect);
    };

    const endDrag = (): void => {
        const drag = dragRef.current;
        if (!drag) {
            return;
        }
        dragRef.current = undefined;
        onCommit(drag.latestRect);
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
                left: imageBox.left,
                top: imageBox.top,
                width: imageBox.width,
                height: imageBox.height,
            }}
        >
            <div
                className={cn(
                    "absolute border border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]",
                    disabled ? "pointer-events-none" : "pointer-events-auto",
                )}
                style={{
                    left: `${shownRect.x * 100}%`,
                    top: `${shownRect.y * 100}%`,
                    width: `${shownRect.width * 100}%`,
                    height: `${shownRect.height * 100}%`,
                    touchAction: "none",
                }}
                {...dragProps("move")}
            >
                {edgeHandles ?
                    EDGE_HANDLES.map(({ handle, hitClass }) => (
                        <span
                            key={handle}
                            className={cn("absolute", hitClass)}
                            {...dragProps(handle)}
                        />
                    )) :
                    null}
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
                {children}
            </div>
        </div>
    );
}
