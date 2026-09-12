import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
    type UIEvent,
} from "react";
import AutoSizer from "react-virtualized-auto-sizer";
import {
    FixedSizeList,
    type ListChildComponentProps,
} from "react-window";
import type { GalleryColumnCount } from "@/lib/app-settings";
import { noteGalleryScrollActivity } from "@/lib/gallery-scroll-activity";
import {
    gridIndicesInContentMarquee,
    type MarqueeRect,
} from "@/lib/marquee-selection";
import {
    computeMasonryLayout,
    masonryItemsInMarquee,
    masonryViewOrderKey,
    visibleMasonryItemsFromColumns,
    type MasonryLayout,
} from "@/lib/masonry-layout";
import {
    computeThumbnailGridLayout,
    rowCountForFiles,
    type ThumbnailGridLayout,
} from "@/lib/thumbnail-grid-layout";
import {
    useMarqueeSelection,
    type MarqueeScrollController,
} from "@/hooks/use-marquee-selection";
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
    onSelectMany?: (fileIds: number[], mode: "add" | "toggle" | "set") => void;
    /**
     * When set, marquee selection is baseline ∪ live intersection (retract
     * deselects). Stamp/tag tools omit this and stay add-only.
     */
    onSetSelection?: (fileIds: number[]) => void;
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
    /** Draft quick-rotate degrees by file id. */
    previewRotationById?: Record<number, 90 | 180 | 270>;
}

interface RowData {
    files: EnteFile[];
    layout: ThumbnailGridLayout;
    onOpenFile?: (file: EnteFile) => void;
    selection?: ThumbnailGridSelection;
    showFileSize?: boolean;
    previewRotationById?: Record<number, 90 | 180 | 270>;
}

const GridRow = memo(function GridRow({
    index,
    style,
    data,
}: ListChildComponentProps<RowData>): JSX.Element {
    const { files, layout, onOpenFile, selection, showFileSize, previewRotationById } =
        data;
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
                previewRotationDegrees={previewRotationById?.[file.id]}
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
    previewRotationById?: Record<number, 90 | 180 | 270>;
    onScrollOffsetChange: (offset: number) => void;
    listRef: RefObject<FixedSizeList<RowData> | null>;
    scrollControllerRef: RefObject<MarqueeScrollController | null>;
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
    previewRotationById,
    onScrollOffsetChange,
    listRef,
    scrollControllerRef,
}: SizedGridProps): JSX.Element {
    const layout: ThumbnailGridLayout = useMemo(
        () => computeThumbnailGridLayout(width, columns),
        [columns, width],
    );
    const rowCount: number = rowCountForFiles(files.length, layout.columns);
    const itemData: RowData = useMemo(
        () => ({
            files,
            layout,
            onOpenFile,
            selection,
            showFileSize,
            previewRotationById,
        }),
        [files, layout, onOpenFile, previewRotationById, selection, showFileSize],
    );

    const itemKey = useCallback(
        (index: number): number => files[index * layout.columns]?.id ?? index,
        [files, layout.columns],
    );

    const scrollOffsetRef = useRef(0);

    useEffect(() => {
        scrollControllerRef.current = {
            getScrollTop: (): number => scrollOffsetRef.current,
            setScrollTop: (next: number): void => {
                const clamped = Math.max(0, next);
                noteGalleryScrollActivity();
                scrollOffsetRef.current = clamped;
                listRef.current?.scrollTo(clamped);
                onScrollOffsetChange(clamped);
            },
        };
        return (): void => {
            scrollControllerRef.current = null;
        };
    }, [listRef, onScrollOffsetChange, scrollControllerRef]);

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
            overscanCount={2}
            onScroll={(props) => {
                noteGalleryScrollActivity();
                scrollOffsetRef.current = props.scrollOffset;
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
    previewRotationById?: Record<number, 90 | 180 | 270>;
    onScrollOffsetChange: (offset: number) => void;
    scrollControllerRef: RefObject<MarqueeScrollController | null>;
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
    previewRotationById,
    onScrollOffsetChange,
    scrollControllerRef,
    viewOrderKey,
}: SizedMasonryGridProps): JSX.Element {
    const [scrollTop, setScrollTop] = useState<number>(0);
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
        const node = scrollerRef.current;
        if (!node) {
            return;
        }
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        const next = Math.min(node.scrollTop, maxScroll);
        setScrollTop((prev) => (prev === next ? prev : next));
        onScrollOffsetChange(next);
    }, [height, onScrollOffsetChange, placedLayout.totalHeight, viewOrderKey]);

    useEffect(() => {
        scrollControllerRef.current = {
            getScrollTop: (): number => scrollerRef.current?.scrollTop ?? 0,
            setScrollTop: (next: number): void => {
                const node = scrollerRef.current;
                if (!node) {
                    return;
                }
                const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
                const clamped = Math.min(Math.max(0, next), maxScroll);
                if (node.scrollTop === clamped) {
                    return;
                }
                noteGalleryScrollActivity();
                node.scrollTop = clamped;
                onScrollOffsetChange(clamped);
                setScrollTop(clamped);
            },
        };
        return (): void => {
            scrollControllerRef.current = null;
        };
    }, [onScrollOffsetChange, scrollControllerRef]);

    const handleScroll = useCallback(
        (event: UIEvent<HTMLDivElement>): void => {
            const nextScrollTop = event.currentTarget.scrollTop;
            noteGalleryScrollActivity();
            // Keep visibility window in sync with hit targets (no rAF lag).
            onScrollOffsetChange(nextScrollTop);
            setScrollTop((prev) => (prev === nextScrollTop ? prev : nextScrollTop));
        },
        [onScrollOffsetChange],
    );

    return (
        <div
            ref={scrollerRef}
            className="overflow-y-auto"
            style={{ width, height, overflowAnchor: "none" }}
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
                                previewRotationDegrees={
                                    previewRotationById?.[item.fileId]
                                }
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export const ThumbnailGrid = memo(function ThumbnailGrid({
    files,
    onOpenFile,
    selection,
    footerInsetPx = 0,
    showFileSize = false,
    previewRotationById,
}: ThumbnailGridProps): JSX.Element {
    const galleryColumns = useSettingsStore((s) => s.galleryColumns);
    const galleryThumbnailMode = useSettingsStore((s) => s.galleryThumbnailMode);
    const listRef = useRef<FixedSizeList<RowData>>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollControllerRef = useRef<MarqueeScrollController | null>(null);
    const marqueeBaselineRef = useRef<Set<number>>(new Set());
    const marqueeAppliedIdsRef = useRef<Set<number>>(new Set());
    const [gridWidth, setGridWidth] = useState<number>(0);

    const handleScrollOffsetChange = useCallback((_offset: number): void => {
        // Scroll offset is owned by scrollControllerRef inside the sized grids.
    }, []);

    const viewOrderKey = useMemo(
        () =>
            galleryThumbnailMode === "fit" ? masonryViewOrderKey(files) : "",
        [files, galleryThumbnailMode],
    );

    // Block taps while order/geometry settles (ghost opens on remount / sort).
    // Stale readyToken keeps pointer-events off until two rAFs land — no sync setState.
    const settleToken = `${viewOrderKey}|${gridWidth}|${files.length}|${galleryThumbnailMode}`;
    const [readyToken, setReadyToken] = useState("");
    useEffect(() => {
        if (files.length === 0 || gridWidth <= 0) {
            return;
        }
        let cancelled = false;
        let innerRaf = 0;
        const outerRaf = requestAnimationFrame(() => {
            innerRaf = requestAnimationFrame(() => {
                if (!cancelled) {
                    setReadyToken(settleToken);
                }
            });
        });
        return (): void => {
            cancelled = true;
            cancelAnimationFrame(outerRaf);
            if (innerRaf !== 0) {
                cancelAnimationFrame(innerRaf);
            }
        };
    }, [files.length, galleryThumbnailMode, gridWidth, settleToken]);
    const interactionsReady =
        readyToken === settleToken && files.length > 0 && gridWidth > 0;

    const resolveMarqueeFileIds = useCallback(
        (rect: MarqueeRect): number[] => {
            if (rect.width < 8 && rect.height < 8) {
                return [];
            }
            if (galleryThumbnailMode === "fit") {
                const layout = computeMasonryLayout(
                    files,
                    gridWidth,
                    galleryColumns,
                );
                return masonryItemsInMarquee(layout.items, rect).map((id) => Number(id));
            }
            const layout = computeThumbnailGridLayout(gridWidth, galleryColumns);
            const indices = gridIndicesInContentMarquee(
                files.length,
                layout.columns,
                layout.rowHeight,
                layout.itemSize,
                layout.paddingInline,
                layout.gap,
                rect,
            );
            return indices.map((index) => files[index]!.id);
        },
        [files, galleryColumns, galleryThumbnailMode, gridWidth],
    );

    const handleMarqueeRect = useCallback(
        (rect: MarqueeRect): void => {
            if (!selection?.onSelectMany) {
                return;
            }
            const fileIds = resolveMarqueeFileIds(rect);
            if (selection.onSetSelection) {
                const next = new Set(marqueeBaselineRef.current);
                for (const id of fileIds) {
                    next.add(id);
                }
                selection.onSetSelection([...next]);
                return;
            }
            // Stamp / add-only tools: never retract (can't un-apply tags).
            const fresh: number[] = [];
            for (const id of fileIds) {
                if (!marqueeAppliedIdsRef.current.has(id)) {
                    marqueeAppliedIdsRef.current.add(id);
                    fresh.push(id);
                }
            }
            if (fresh.length > 0) {
                selection.onSelectMany(fresh, "add");
            }
        },
        [resolveMarqueeFileIds, selection],
    );

    const marqueeEnabled =
        Boolean(selection?.onSelectMany) && !selection?.disabled;

    const {
        marqueeViewport,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
    } = useMarqueeSelection({
        enabled: marqueeEnabled,
        containerRef,
        scrollControllerRef,
        onMarqueeRect: handleMarqueeRect,
    });

    const handlePointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>): void => {
            marqueeBaselineRef.current = new Set(selection?.selectedIds ?? []);
            marqueeAppliedIdsRef.current = new Set();
            onPointerDown(event);
        },
        [onPointerDown, selection?.selectedIds],
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
            className="relative min-h-0 flex-1 select-none overflow-hidden"
            style={{
                // Select/stamp: block native pan so any-direction drag selects;
                // navigate via edge auto-scroll while dragging (iOS Photos).
                touchAction: marqueeEnabled ? "none" : "pan-y",
                pointerEvents: interactionsReady ? "auto" : "none",
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
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
                            previewRotationById={previewRotationById}
                            onScrollOffsetChange={handleScrollOffsetChange}
                            scrollControllerRef={scrollControllerRef}
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
                            previewRotationById={previewRotationById}
                            onScrollOffsetChange={handleScrollOffsetChange}
                            listRef={listRef}
                            scrollControllerRef={scrollControllerRef}
                        />
                    )}
            </AutoSizer>
            {marqueeViewport ? (
                <div
                    className="pointer-events-none absolute z-30 border border-primary bg-primary/20"
                    style={{
                        left: marqueeViewport.x,
                        top: marqueeViewport.y,
                        width: marqueeViewport.width,
                        height: marqueeViewport.height,
                    }}
                />
            ) : null}
        </div>
    );
});
