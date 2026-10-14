import {
    memo,
    useEffect,
    useRef,
    useSyncExternalStore,
    type JSX,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { QuickCropOverlay } from "@/components/QuickCropOverlay";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
    getThumbnailEntry,
    requestThumbnail,
    subscribeThumbnail,
} from "@/lib/thumbnail-cache";
import { fileByteSize } from "@/lib/compress";
import { previewTransformForRotation } from "@/lib/rotate-draft";
import type { RotationDegrees } from "@/lib/rotate";
import { Check, CircleCheck, Play } from "lucide-react";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import { selectedIdSet, useSelectionStore } from "@/stores/selection-store";
import { formatFileSize } from "@/lib/format";

const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_PX = 10;

interface ThumbnailCellProps {
    file: EnteFile;
    size?: number;
    width?: number;
    height?: number;
    objectFit?: "cover" | "contain";
    onOpen?: (file: EnteFile) => void;
    isSelected?: boolean;
    onToggleSelect?: (file: EnteFile, imageAspect?: number) => void;
    isAlreadyCompressed?: boolean;
    disabled?: boolean;
    /** When true, tap toggles selection instead of opening. */
    tapSelects?: boolean;
    /** Compress picker: show file size chip (bottom-left). */
    showFileSize?: boolean;
    /** Draft quick-rotate preview (CSS only). */
    previewRotationDegrees?: RotationDegrees;
    /**
     * When true, selected chrome follows the selection store for this file id
     * so virtualized grids do not rebuild every cell on each toggle.
     */
    observeStoreSelection?: boolean;
    /** Quick-crop tool: draw this file's draft crop box over the tile. */
    cropMode?: boolean;
}

/** Skip re-render when the same file is shown with the same chrome. */
const thumbnailCellPropsAreEqual = (
    prev: ThumbnailCellProps,
    next: ThumbnailCellProps,
): boolean =>
    prev.file.id === next.file.id &&
    prev.file.key === next.file.key &&
    prev.file.metadata.fileType === next.file.metadata.fileType &&
    prev.file.info?.fileSize === next.file.info?.fileSize &&
    prev.size === next.size &&
    prev.width === next.width &&
    prev.height === next.height &&
    prev.objectFit === next.objectFit &&
    prev.onOpen === next.onOpen &&
    prev.onToggleSelect === next.onToggleSelect &&
    prev.isAlreadyCompressed === next.isAlreadyCompressed &&
    prev.disabled === next.disabled &&
    prev.tapSelects === next.tapSelects &&
    prev.showFileSize === next.showFileSize &&
    prev.previewRotationDegrees === next.previewRotationDegrees &&
    prev.observeStoreSelection === next.observeStoreSelection &&
    prev.cropMode === next.cropMode &&
    (Boolean(prev.observeStoreSelection) || prev.isSelected === next.isSelected);

export const ThumbnailCell = memo(function ThumbnailCell({
    file,
    size,
    width,
    height,
    objectFit = "cover",
    onOpen,
    isSelected = false,
    onToggleSelect,
    isAlreadyCompressed = false,
    disabled = false,
    tapSelects = false,
    showFileSize = false,
    previewRotationDegrees,
    observeStoreSelection = false,
    cropMode = false,
}: ThumbnailCellProps): JSX.Element {
    const cellWidth = width ?? size ?? 0;
    const cellHeight = height ?? size ?? 0;
    const imageFitClass =
        objectFit === "contain" ? "object-contain" : "object-cover";
    const sizeBytes = fileByteSize(file);
    const selectedFromStore = useSelectionStore((s) =>
        observeStoreSelection && s.enabled ?
            selectedIdSet(s.selectedIds).has(file.id) :
            false);
    const pendingCrop = useSelectionStore((s) =>
        cropMode ? s.pendingCrops[file.id] : undefined);
    const showSelected = observeStoreSelection ? selectedFromStore : isSelected;
    const previewTransform =
        previewRotationDegrees !== undefined ?
            previewTransformForRotation(
                previewRotationDegrees,
                cellWidth,
                cellHeight,
            ) :
            undefined;

    const entry = useSyncExternalStore(
        (listener) => subscribeThumbnail(file.id, listener),
        () => getThumbnailEntry(file.id),
        () => getThumbnailEntry(file.id),
    );

    const imageRef = useRef<HTMLImageElement>(null);
    const pressTimerRef = useRef<number | undefined>(undefined);
    const pressStartRef = useRef<{ x: number; y: number } | undefined>(undefined);
    const longPressTriggeredRef = useRef<boolean>(false);

    useEffect(() => {
        if (entry.status === "idle" || entry.status === "error") {
            // requestThumbnail applies the failed-load cooldown and retry cap.
            requestThumbnail(file);
        }
    }, [entry.status, file]);

    useEffect(() => {
        return (): void => {
            if (pressTimerRef.current !== undefined) {
                window.clearTimeout(pressTimerRef.current);
            }
        };
    }, []);

    const clearPress = (): void => {
        if (pressTimerRef.current !== undefined) {
            window.clearTimeout(pressTimerRef.current);
            pressTimerRef.current = undefined;
        }
        pressStartRef.current = undefined;
    };

    const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
        if (disabled) {
            return;
        }
        longPressTriggeredRef.current = false;
        pressStartRef.current = { x: event.clientX, y: event.clientY };
        if (!tapSelects && onOpen) {
            pressTimerRef.current = window.setTimeout(() => {
                pressTimerRef.current = undefined;
                longPressTriggeredRef.current = true;
                onOpen(file);
            }, LONG_PRESS_MS);
        }
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
        const start = pressStartRef.current;
        if (!start || pressTimerRef.current === undefined) {
            return;
        }
        if (
            Math.hypot(event.clientX - start.x, event.clientY - start.y) >
            LONG_PRESS_MOVE_PX
        ) {
            clearPress();
        }
    };

    const handleClick = (): void => {
        if (disabled) {
            return;
        }
        if (longPressTriggeredRef.current) {
            longPressTriggeredRef.current = false;
            clearPress();
            return;
        }
        clearPress();
        if (tapSelects && onToggleSelect) {
            const image = imageRef.current;
            onToggleSelect(
                file,
                image && image.naturalHeight > 0 ?
                    image.naturalWidth / image.naturalHeight :
                    undefined,
            );
            return;
        }
        onOpen?.(file);
    };

    return (
        <div
            className={cn(
                "relative shrink-0 overflow-hidden rounded-md bg-muted",
                disabled && "pointer-events-none opacity-50",
            )}
            style={{ width: cellWidth, height: cellHeight }}
        >
            <button
                type="button"
                className="size-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={clearPress}
                onPointerCancel={clearPress}
                onClick={handleClick}
                disabled={disabled}
                aria-label={
                    tapSelects ?
                        previewRotationDegrees !== undefined ?
                            `Rotate media ${file.id}, pending ${previewRotationDegrees} degrees` :
                            showSelected ?
                                `Deselect media ${file.id}` :
                                `Select media ${file.id}` :
                        `Open media ${file.id}`
                }
                aria-pressed={tapSelects ? showSelected : undefined}
            >
                {file.metadata.fileType === FileType.video && !tapSelects ? (
                    <span className="absolute bottom-1 right-1 z-10 rounded-full bg-black/60 p-1 text-white">
                        <Play className="size-3 fill-current" aria-hidden />
                    </span>
                ) : null}
                {entry.status === "ready" && entry.url ? (
                    <img
                        ref={imageRef}
                        className={cn(
                            "pointer-events-none size-full",
                            imageFitClass,
                        )}
                        style={
                            previewTransform ?
                                { transform: previewTransform } :
                                undefined
                        }
                        src={entry.url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                    />
                ) : entry.status === "error" ? (
                    <span
                        className="flex size-full items-center justify-center text-sm text-destructive"
                        aria-hidden
                    >
                        !
                    </span>
                ) : (
                    <Skeleton className="size-full rounded-none" aria-hidden />
                )}
            </button>
            {pendingCrop ? (
                <QuickCropOverlay
                    fileId={file.id}
                    crop={pendingCrop}
                    cellWidth={cellWidth}
                    cellHeight={cellHeight}
                    disabled={disabled}
                />
            ) : null}
            {previewRotationDegrees !== undefined ? (
                <span
                    className="pointer-events-none absolute top-1 right-1 z-10 rounded bg-black/70 px-1 py-0.5 text-[10px] leading-none text-white"
                    aria-hidden
                >
                    {previewRotationDegrees}°
                </span>
            ) : null}
            {isAlreadyCompressed ? (
                <span
                    className="absolute top-1.5 left-1.5 z-10 flex size-5 items-center justify-center rounded-full bg-green-600 text-white"
                    aria-hidden
                >
                    <CircleCheck className="size-3.5" strokeWidth={2.5} />
                </span>
            ) : null}
            {showFileSize && sizeBytes > 0 ? (
                <span
                    className="pointer-events-none absolute bottom-1 left-1 z-10 rounded bg-black/60 px-1 py-0.5 text-[10px] leading-none text-white"
                    aria-hidden
                >
                    {formatFileSize(sizeBytes)}
                </span>
            ) : null}
            {tapSelects && showSelected ? <SelectedTileOverlay /> : null}
        </div>
    );
}, thumbnailCellPropsAreEqual);

/** Tint and check badge drawn over a selected tile. */
export function SelectedTileOverlay(): JSX.Element {
    return (
        <>
            <span
                className="pointer-events-none absolute inset-0 z-[1] bg-primary/30"
                aria-hidden
            />
            <span
                className="pointer-events-none absolute right-1.5 bottom-1.5 z-10 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground"
                aria-hidden
            >
                <Check className="size-4" strokeWidth={3} />
            </span>
        </>
    );
}
