import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
    type RefObject,
    type UIEvent,
} from "react";
import AutoSizer from "react-virtualized-auto-sizer";
import {
    FixedSizeList,
    type ListChildComponentProps,
} from "react-window";
import type { GalleryColumnCount } from "@/lib/app-settings";
import { resolveMarqueeDragIntent } from "@/lib/compress";
import { noteGalleryScrollActivity } from "@/lib/gallery-scroll-activity";
import {
    computeMasonryLayout,
    masonryItemsInMarquee,
    visibleMasonryItemsFromColumns,
    type MasonryLayout,
} from "@/lib/masonry-layout";
import {
    computeThumbnailGridLayout,
    rowCountForFiles,
    type ThumbnailGridLayout,
} from "@/lib/thumbnail-grid-layout";
import { useSettingsStore } from "@/stores/settings-store";
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
    /** Compress picker: show size chips on cells. */
    showFileSize?: boolean;
}

interface RowData {
    files: EnteFile[];
    layout: ThumbnailGridLayout;
    onOpenFile?: (file: EnteFile) => void;
    selection?: ThumbnailGridSelection;
    showFileSize?: boolean;
}

const GridRow = memo(function GridRow({
    index,
    style,
    data,
}: ListChildComponentProps<RowData>): JSX.Element {
    const { files, layout, onOpenFile, selection, showFileSize } = data;
    const start: number = index * layout.columns;
    const cells: JSX.Element[] = [];
    for (let column = 0; column < layout.columns; column += 1) {
        const file = files[start + column];
        if (!file) {
            break;
        }
        cells.push(
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
                showFileSize={showFileSize}
            />,
        );
    }

    return (
        <div
            className="flex w-full"
            style={{
                ...style,
                paddingInline: layout.paddingInline,
                gap: layout.gap,
            }}
        >
            {cells}
        </div>
    );
});

interface SizedGridProps {
    files: EnteFile[];
    width: number;
    height: number;
    columns: GalleryColumnCount;
    onOpenFile?: (file: EnteFile) => void;
    selection?: ThumbnailGridSelection;
    footerInsetPx: number;
    showFileSize?: boolean;
    onScrollOffsetChange: (offset: number) => void;
    listRef: RefObject<FixedSizeList<RowData> | null>;
}

function SizedGrid({
    files,
    width,
    height,
    columns,
    onOpenFile,
    selection,
    footerInsetPx,
    showFileSize,
    onScrollOffsetChange,
    listRef,
}: SizedGridProps): JSX.Element {
    const layout: ThumbnailGridLayout = useMemo(
        () => computeThumbnailGridLayout(width, columns),
        [columns, width],
    );
    const rowCount: number = rowCountForFiles(files.length, layout.columns);
    const itemData: RowData = useMemo(
        () => ({ files, layout, onOpenFile, selection, showFileSize }),
        [files, layout, onOpenFile, selection, showFileSize],
    );

    const itemKey = useCallback(
        (index: number): number => files[index * layout.columns]?.id ?? index,
        [files, layout.columns],
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
            itemKey={itemKey}
            overscanCount={4}
            onScroll={(props) => {
                noteGalleryScrollActivity();
                onScrollOffsetChange(props.scrollOffset);
            }}
            style={{ paddingBottom: footerInsetPx }}
        >
            {GridRow}
        </FixedSizeList>
    );
}

interface SizedMasonryGridProps {
    files: EnteFile[];
    width: number;
    height: number;
    columns: GalleryColumnCount;
    onOpenFile?: (file: EnteFile) => void;
    selection?: ThumbnailGridSelection;
    footerInsetPx: number;
    showFileSize?: boolean;
    onScrollOffsetChange: (offset: number) => void;
    /** Generation that changes when id order changes; layout is reused otherwise. */
    viewOrderKey: string;
}

const MASONRY_OVERSCAN_PX = 480;

function SizedMasonryGrid({
    files,
    width,
    height,
    columns,
    onOpenFile,
    selection,
    footerInsetPx,
    showFileSize,
    onScrollOffsetChange,
    viewOrderKey,
}: SizedMasonryGridProps): JSX.Element {
    const [scrollTop, setScrollTop] = useState<number>(0);
    const pendingScrollTopRef = useRef<number>(0);
    const scrollRafRef = useRef<number | undefined>(undefined);
    const scrollerRef = useRef<HTMLDivElement>(null);

    const placedLayout: MasonryLayout = useMemo(
        () => computeMasonryLayout(files, width, columns),
        // Placement depends on id order + geometry, not file object identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- viewOrderKey
        [columns, viewOrderKey, width],
    );
    const visibleItems = useMemo(
        () =>
            visibleMasonryItemsFromColumns(
                placedLayout.itemsByColumn,
                scrollTop,
                height,
                MASONRY_OVERSCAN_PX,
            ),
        [height, placedLayout.itemsByColumn, scrollTop],
    );

    useEffect(() => {
        return (): void => {
            if (scrollRafRef.current !== undefined) {
                cancelAnimationFrame(scrollRafRef.current);
            }
        };
    }, []);

    useEffect(() => {
        const node = scrollerRef.current;
        if (!node) {
            return;
        }
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        const next = Math.min(node.scrollTop, maxScroll);
        pendingScrollTopRef.current = next;
        setScrollTop((prev) => (prev === next ? prev : next));
        onScrollOffsetChange(next);
    }, [height, onScrollOffsetChange, placedLayout.totalHeight, viewOrderKey]);

    const handleScroll = useCallback(
        (event: UIEvent<HTMLDivElement>): void => {
            const nextScrollTop = event.currentTarget.scrollTop;
            noteGalleryScrollActivity();
            pendingScrollTopRef.current = nextScrollTop;
            // Marquee / selection use the latest offset immediately.
            onScrollOffsetChange(nextScrollTop);
            if (scrollRafRef.current !== undefined) {
                return;
            }
            scrollRafRef.current = requestAnimationFrame(() => {
                scrollRafRef.current = undefined;
                setScrollTop(pendingScrollTopRef.current);
            });
        },
        [onScrollOffsetChange],
    );

    return (
        <div
            ref={scrollerRef}
            className="overflow-y-auto"
            style={{ width, height }}
            onScroll={handleScroll}
        >
            <div
                className="relative w-full"
                style={{
                    height: placedLayout.totalHeight + footerInsetPx,
                }}
            >
                {visibleItems.map((item) => {
                    const file = files[item.index] ?? item.file;
                    return (
                        <div
                            key={item.fileId}
                            className="absolute"
                            style={{
                                left: item.x,
                                top: item.y,
                                width: item.width,
                                height: item.height,
                            }}
                        >
                            <ThumbnailCell
                                file={file}
                                width={item.width}
                                height={item.height}
                                objectFit="contain"
                                onOpen={onOpenFile}
                                isSelected={selection?.selectedIds.has(item.fileId)}
                                onToggleSelect={selection?.onToggle}
                                isAlreadyCompressed={selection?.isAlreadyCompressed?.(
                                    file,
                                )}
                                disabled={selection?.disabled}
                                tapSelects={selection !== undefined}
                                showFileSize={showFileSize}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
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

export const ThumbnailGrid = memo(function ThumbnailGrid({
    files,
    onOpenFile,
    selection,
    footerInsetPx = 0,
    showFileSize = false,
}: ThumbnailGridProps): JSX.Element {
    const galleryColumns = useSettingsStore((s) => s.galleryColumns);
    const galleryThumbnailMode = useSettingsStore((s) => s.galleryThumbnailMode);
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

    const viewOrderKey = useMemo(
        () =>
            galleryThumbnailMode === "fit" ?
                files.map((file) => file.id).join(",") :
                "",
        [files, galleryThumbnailMode],
    );

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
            let fileIds: number[];
            if (galleryThumbnailMode === "fit") {
                const layout = computeMasonryLayout(
                    files,
                    gridWidth,
                    galleryColumns,
                );
                fileIds = masonryItemsInMarquee(
                    layout.items,
                    scrollTopRef.current,
                    rect,
                ).map((id) => Number(id));
            } else {
                const layout = computeThumbnailGridLayout(
                    gridWidth,
                    galleryColumns,
                );
                fileIds = fileIdsInMarquee(
                    files,
                    layout,
                    scrollTopRef.current,
                    rect,
                );
            }
            if (fileIds.length > 0) {
                selection.onSelectMany(fileIds, "add");
            }
        },
        [files, galleryColumns, galleryThumbnailMode, gridWidth, selection],
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
                {({ height, width }: { height: number; width: number }) =>
                    galleryThumbnailMode === "fit" ? (
                        <SizedMasonryGrid
                            files={files}
                            width={width}
                            height={height}
                            columns={galleryColumns}
                            onOpenFile={onOpenFile}
                            selection={selection}
                            footerInsetPx={footerInsetPx}
                            showFileSize={showFileSize}
                            onScrollOffsetChange={handleScrollOffsetChange}
                            viewOrderKey={viewOrderKey}
                        />
                    ) : (
                        <SizedGrid
                            files={files}
                            width={width}
                            height={height}
                            columns={galleryColumns}
                            onOpenFile={onOpenFile}
                            selection={selection}
                            footerInsetPx={footerInsetPx}
                            showFileSize={showFileSize}
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
});
