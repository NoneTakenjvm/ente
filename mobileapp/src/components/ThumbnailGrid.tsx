import { memo, useCallback, useMemo, useRef, useState, type JSX, type RefObject } from "react";
import AutoSizer from "react-virtualized-auto-sizer";
import {
    FixedSizeList,
    type ListChildComponentProps,
} from "react-window";
import {
    computeThumbnailGridLayout,
    rowCountForFiles,
    type ThumbnailGridLayout,
} from "@/lib/thumbnail-grid-layout";
import { resolveMarqueeDragIntent } from "@/lib/compress";
import type { EnteFile } from "ente-media/file";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "@/components/ui/empty";
import { Images } from "lucide-react";
import { ThumbnailCell } from "./ThumbnailCell";

export interface ThumbnailGridSelection {
    selectedIds: Set<number>;
    onToggle: (file: EnteFile) => void;
    onSelectMany?: (fileIds: number[], mode: "add" | "toggle") => void;
    isAlreadyCompressed?: (file: EnteFile) => boolean;
    disabled?: boolean;
}

interface ThumbnailGridProps {
    files: EnteFile[];
    onOpenFile?: (file: EnteFile) => void;
    selection?: ThumbnailGridSelection;
    /** Bottom padding so the last row clears a fixed footer (px). */
    footerInsetPx?: number;
}

interface RowData {
    files: EnteFile[];
    layout: ThumbnailGridLayout;
    onOpenFile?: (file: EnteFile) => void;
    selection?: ThumbnailGridSelection;
}

const GridRow = memo(function GridRow({
    index,
    style,
    data,
}: ListChildComponentProps<RowData>): JSX.Element {
    const { files, layout, onOpenFile, selection } = data;
    const start: number = index * layout.columns;
    const rowFiles: EnteFile[] = files.slice(start, start + layout.columns);

    return (
        <div
            className="flex w-full"
            style={{
                ...style,
                paddingInline: layout.paddingInline,
                gap: layout.gap,
            }}
        >
            {rowFiles.map((file) => (
                <ThumbnailCell
                    key={file.id}
                    file={file}
                    size={layout.itemSize}
                    onOpen={onOpenFile}
                    isSelected={selection?.selectedIds.has(file.id)}
                    onToggleSelect={selection?.onToggle}
                    isAlreadyCompressed={selection?.isAlreadyCompressed?.(file)}
                    disabled={selection?.disabled}
                    tapSelects={selection !== undefined}
                />
            ))}
        </div>
    );
});

interface SizedGridProps {
    files: EnteFile[];
    width: number;
    height: number;
    onOpenFile?: (file: EnteFile) => void;
    selection?: ThumbnailGridSelection;
    footerInsetPx: number;
    onScrollOffsetChange: (offset: number) => void;
    listRef: RefObject<FixedSizeList<RowData> | null>;
}

function SizedGrid({
    files,
    width,
    height,
    onOpenFile,
    selection,
    footerInsetPx,
    onScrollOffsetChange,
    listRef,
}: SizedGridProps): JSX.Element {
    const layout: ThumbnailGridLayout = useMemo(
        () => computeThumbnailGridLayout(width),
        [width],
    );
    const rowCount: number = rowCountForFiles(files.length, layout.columns);
    const itemData: RowData = useMemo(
        () => ({ files, layout, onOpenFile, selection }),
        [files, layout, onOpenFile, selection],
    );

    return (
        <FixedSizeList
            ref={listRef}
            key={`${width}-${layout.columns}`}
            height={height}
            width={width}
            itemCount={rowCount}
            itemSize={layout.rowHeight}
            itemData={itemData}
            onScroll={(props) => {
                onScrollOffsetChange(props.scrollOffset);
            }}
            style={{ paddingBottom: footerInsetPx }}
        >
            {GridRow}
        </FixedSizeList>
    );
}

const MARQUEE_ARM_THRESHOLD_PX = 12;

interface MarqueeRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

const normalizeRect = (a: { x: number; y: number }, b: { x: number; y: number }): MarqueeRect => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
});

const fileIdsInMarquee = (
    files: EnteFile[],
    layout: ThumbnailGridLayout,
    scrollTop: number,
    rect: MarqueeRect,
): number[] => {
    const ids: number[] = [];
    const rowCount = rowCountForFiles(files.length, layout.columns);
    for (let row = 0; row < rowCount; row += 1) {
        const rowTop = row * layout.rowHeight - scrollTop;
        const rowBottom = rowTop + layout.itemSize;
        if (rowBottom < rect.y || rowTop > rect.y + rect.height) {
            continue;
        }
        for (let col = 0; col < layout.columns; col += 1) {
            const index = row * layout.columns + col;
            if (index >= files.length) {
                break;
            }
            const cellLeft =
                layout.paddingInline + col * (layout.itemSize + layout.gap);
            const cellRight = cellLeft + layout.itemSize;
            const cellTop = rowTop;
            const cellBottom = rowBottom;
            const overlaps =
                cellRight >= rect.x &&
                cellLeft <= rect.x + rect.width &&
                cellBottom >= rect.y &&
                cellTop <= rect.y + rect.height;
            if (overlaps) {
                ids.push(files[index].id);
            }
        }
    }
    return ids;
};

export function ThumbnailGrid({
    files,
    onOpenFile,
    selection,
    footerInsetPx = 0,
}: ThumbnailGridProps): JSX.Element {
    const listRef = useRef<FixedSizeList<RowData>>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollTopRef = useRef<number>(0);
    const dragStartRef = useRef<{ x: number; y: number } | undefined>(undefined);
    const dragIntentRef = useRef<"pending" | "scroll" | "marquee">("pending");
    const [marqueeArmed, setMarqueeArmed] = useState<boolean>(false);
    const [marquee, setMarquee] = useState<MarqueeRect | undefined>();
    const [gridWidth, setGridWidth] = useState<number>(0);

    const handleScrollOffsetChange = useCallback((offset: number): void => {
        scrollTopRef.current = offset;
    }, []);

    const finishMarquee = useCallback(
        (endX: number, endY: number): void => {
            const start = dragStartRef.current;
            const intent = dragIntentRef.current;
            dragStartRef.current = undefined;
            dragIntentRef.current = "pending";
            setMarqueeArmed(false);
            setMarquee(undefined);
            if (
                !start ||
                intent !== "marquee" ||
                !selection?.onSelectMany ||
                !containerRef.current
            ) {
                return;
            }
            const rect = normalizeRect(start, { x: endX, y: endY });
            if (rect.width < 8 && rect.height < 8) {
                return;
            }
            const layout = computeThumbnailGridLayout(gridWidth);
            const fileIds = fileIdsInMarquee(
                files,
                layout,
                scrollTopRef.current,
                rect,
            );
            if (fileIds.length > 0) {
                selection.onSelectMany(fileIds, "add");
            }
        },
        [files, gridWidth, selection],
    );

    const cancelMarqueeTracking = useCallback((): void => {
        dragStartRef.current = undefined;
        dragIntentRef.current = "pending";
        setMarqueeArmed(false);
        setMarquee(undefined);
    }, []);

    const handlePointerDown = useCallback(
        (event: React.PointerEvent<HTMLDivElement>): void => {
            if (!selection?.onSelectMany || selection.disabled) {
                return;
            }
            if (event.pointerType === "mouse" && event.button !== 0) {
                return;
            }
            const bounds = containerRef.current?.getBoundingClientRect();
            if (!bounds) {
                return;
            }
            dragIntentRef.current = "pending";
            dragStartRef.current = {
                x: event.clientX - bounds.left,
                y: event.clientY - bounds.top,
            };
        },
        [selection],
    );

    const handlePointerMove = useCallback(
        (event: React.PointerEvent<HTMLDivElement>): void => {
            const start = dragStartRef.current;
            if (!start) {
                return;
            }
            const bounds = containerRef.current?.getBoundingClientRect();
            if (!bounds) {
                return;
            }
            const x = event.clientX - bounds.left;
            const y = event.clientY - bounds.top;
            const dx = x - start.x;
            const dy = y - start.y;

            if (dragIntentRef.current === "pending") {
                const intent = resolveMarqueeDragIntent(
                    dx,
                    dy,
                    MARQUEE_ARM_THRESHOLD_PX,
                );
                if (intent === "scroll") {
                    cancelMarqueeTracking();
                    return;
                }
                if (intent === "marquee") {
                    dragIntentRef.current = "marquee";
                    setMarqueeArmed(true);
                    containerRef.current?.setPointerCapture(event.pointerId);
                    setMarquee(normalizeRect(start, { x, y }));
                }
                return;
            }

            if (dragIntentRef.current === "marquee") {
                setMarquee(normalizeRect(start, { x, y }));
            }
        },
        [cancelMarqueeTracking],
    );

    const handlePointerUp = useCallback(
        (event: React.PointerEvent<HTMLDivElement>): void => {
            if (!dragStartRef.current) {
                return;
            }
            const bounds = containerRef.current?.getBoundingClientRect();
            if (bounds && dragIntentRef.current === "marquee") {
                finishMarquee(
                    event.clientX - bounds.left,
                    event.clientY - bounds.top,
                );
                containerRef.current?.releasePointerCapture(event.pointerId);
                return;
            }
            cancelMarqueeTracking();
        },
        [cancelMarqueeTracking, finishMarquee],
    );

    if (files.length === 0) {
        return (
            <Empty className="flex-1 border-0">
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Images />
                    </EmptyMedia>
                    <EmptyTitle>No photos in this view</EmptyTitle>
                    <EmptyDescription>
                        {selection ?
                            "No compressible files match the current filter." :
                            "Try another album or clear tag filters."}
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        );
    }

    return (
        <div
            ref={containerRef}
            className="relative min-h-0 flex-1 select-none"
            style={{ touchAction: marqueeArmed ? "none" : "pan-y" }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
        >
            <AutoSizer
                onResize={({ width }: { width: number }) => {
                    setGridWidth(width);
                }}
            >
                {({ height, width }: { height: number; width: number }) => (
                    <SizedGrid
                        files={files}
                        width={width}
                        height={height}
                        onOpenFile={onOpenFile}
                        selection={selection}
                        footerInsetPx={footerInsetPx}
                        onScrollOffsetChange={handleScrollOffsetChange}
                        listRef={listRef}
                    />
                )}
            </AutoSizer>
            {marquee ? (
                <div
                    className="pointer-events-none absolute z-30 border border-primary bg-primary/20"
                    style={{
                        left: marquee.x,
                        top: marquee.y,
                        width: marquee.width,
                        height: marquee.height,
                    }}
                />
            ) : null}
        </div>
    );
}
