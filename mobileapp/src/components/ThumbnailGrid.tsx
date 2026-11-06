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
import { useGridMarquee } from "@/hooks/use-grid-marquee";
import { useListScrollController } from "@/hooks/use-list-scroll-controller";
import type { MarqueeScrollController } from "@/hooks/use-marquee-selection";
import { useSettingsStore } from "@/stores/settings-store";
import { useUIStore } from "@/stores/ui-store";
import { useSelectionStore } from "@/stores/selection-store";
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
    /** `imageAspect` is the tapped thumbnail's width / height, when it is loaded. */
    onToggle: (file: EnteFile, imageAspect?: number) => void;
    onSelectMany?: (fileIds: number[], mode: "add" | "toggle" | "set") => void;
    /**
     * When set, marquee selection is baseline ∪ live intersection (retract
     * deselects). Stamp/tag tools omit this and stay add-only.
     */
    onSetSelection?: (fileIds: number[]) => void;
    isAlreadyCompressed?: (file: EnteFile) => boolean;
    disabled?: boolean;
    /**
     * Cells read selected state from the selection store (avoids rebuilding the
     * whole virtualized window on each toggle).
     */
    observeStoreSelection?: boolean;
    /**
     * Quick-crop tool: the grid shows photos uncropped (fit layout) and cells
     * draw their draft crop box.
     */
    cropMode?: boolean;
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

/** Per-cell behaviour and chrome shared by the row grid and the masonry grid. */
interface CellChrome {
    onOpenFile?: (file: EnteFile) => void;
    selection?: ThumbnailGridSelection;
    showFileSize?: boolean;
    previewRotationById?: Record<number, 90 | 180 | 270>;
}

interface RowData {
    files: EnteFile[];
    layout: ThumbnailGridLayout;
    chrome: CellChrome;
}

const cellChromeProps = (
    file: EnteFile,
    { onOpenFile, selection, showFileSize, previewRotationById }: CellChrome,
) => ({
    onOpen: onOpenFile,
    isSelected: selection?.selectedIds.has(file.id),
    onToggleSelect: selection?.onToggle,
    isAlreadyCompressed: selection?.isAlreadyCompressed?.(file),
    disabled: selection?.disabled,
    tapSelects: selection !== undefined,
    showFileSize,
    previewRotationDegrees: previewRotationById?.[file.id],
    observeStoreSelection: selection?.observeStoreSelection,
    cropMode: selection?.cropMode,
});

const GridRow = memo(function GridRow({
    index,
    style,
    data,
}: ListChildComponentProps<RowData>): JSX.Element {
    const { files, layout, chrome } = data;
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
                {...cellChromeProps(file, chrome)}
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
    chrome: CellChrome;
    footerInsetPx: number;
    listRef: RefObject<FixedSizeList<RowData> | null>;
    scrollControllerRef: RefObject<MarqueeScrollController | null>;
}

function SizedGrid({
    files,
    width,
    height,
    columns,
    chrome,
    footerInsetPx,
    listRef,
    scrollControllerRef,
}: SizedGridProps): JSX.Element {
    const layout: ThumbnailGridLayout = useMemo(
        () => computeThumbnailGridLayout(width, columns),
        [columns, width],
    );
    const rowCount: number = rowCountForFiles(files.length, layout.columns);
    const itemData: RowData = useMemo(
        () => ({ files, layout, chrome }),
        [chrome, files, layout],
    );

    const itemKey = useCallback(
        (index: number): number => files[index * layout.columns]?.id ?? index,
        [files, layout.columns],
    );

    const { outerRef, onScroll } = useListScrollController(
        listRef,
        scrollControllerRef,
    );

    return (
        <FixedSizeList
            ref={listRef}
            outerRef={outerRef}
            key={`${width}-${layout.columns}`}
            height={height}
            width={width}
            itemCount={rowCount}
            itemSize={layout.rowHeight}
            itemData={itemData}
            itemKey={itemKey}
            overscanCount={2}
            onScroll={onScroll}
            style={{ paddingBottom: footerInsetPx, touchAction: "pan-y" }}
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
    chrome: CellChrome;
    footerInsetPx: number;
    scrollControllerRef: RefObject<MarqueeScrollController | null>;
    /** Receives the placed layout so marquee hit-tests reuse it. */
    layoutRef: RefObject<MasonryLayout | null>;
    /** Generation that changes when id order or pixel size changes; layout is reused otherwise. */
    viewOrderKey: string;
}

const MASONRY_OVERSCAN_PX = 480;

function SizedMasonryGrid({
    files,
    width,
    height,
    columns,
    chrome,
    footerInsetPx,
    scrollControllerRef,
    layoutRef,
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
    useEffect(() => {
        layoutRef.current = placedLayout;
    }, [layoutRef, placedLayout]);
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
    }, [height, placedLayout.totalHeight, viewOrderKey]);

    // "Set Relative" re-ranks the whole gallery: start at the closest images.
    const relativeAnchorEpoch = useUIStore((s) => s.relativeAnchorEpoch);
    const seenAnchorEpochRef = useRef(relativeAnchorEpoch);
    useEffect(() => {
        if (seenAnchorEpochRef.current === relativeAnchorEpoch) {
            return;
        }
        seenAnchorEpochRef.current = relativeAnchorEpoch;
        if (scrollerRef.current) {
            scrollerRef.current.scrollTop = 0;
        }
        setScrollTop(0);
    }, [relativeAnchorEpoch]);

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
                setScrollTop(clamped);
            },
        };
        return (): void => {
            scrollControllerRef.current = null;
        };
    }, [scrollControllerRef]);

    const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
        const nextScrollTop = event.currentTarget.scrollTop;
        noteGalleryScrollActivity();
        setScrollTop((prev) => (prev === nextScrollTop ? prev : nextScrollTop));
    };

    return (
        <div
            ref={scrollerRef}
            className="overflow-y-auto"
            style={{ width, height, overflowAnchor: "none", touchAction: "pan-y" }}
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
                                {...cellChromeProps(file, chrome)}
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
    const savedThumbnailMode = useSettingsStore((s) => s.galleryThumbnailMode);
    // Crop needs whole photos; the saved setting is never written.
    const thumbnailMode = selection?.cropMode ? "fit" : savedThumbnailMode;
    const listRef = useRef<FixedSizeList<RowData>>(null);
    const scrollControllerRef = useRef<MarqueeScrollController | null>(null);
    const masonryLayoutRef = useRef<MasonryLayout | null>(null);
    const [gridWidth, setGridWidth] = useState<number>(0);

    const chrome: CellChrome = useMemo(
        () => ({ onOpenFile, selection, showFileSize, previewRotationById }),
        [onOpenFile, previewRotationById, selection, showFileSize],
    );

    const viewOrderKey = useMemo(
        () =>
            thumbnailMode === "fit" ? masonryViewOrderKey(files) : "",
        [files, thumbnailMode],
    );

    // Block taps while order/geometry settles (ghost opens on remount / sort).
    // Stale readyToken keeps pointer-events off until two rAFs land — no sync setState.
    const settleToken = `${viewOrderKey}|${gridWidth}|${files.length}|${thumbnailMode}`;
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
    }, [files.length, thumbnailMode, gridWidth, settleToken]);
    const interactionsReady =
        readyToken === settleToken && files.length > 0 && gridWidth > 0;

    const resolveMarqueeFileIds = useCallback(
        (rect: MarqueeRect): number[] => {
            if (rect.width < 8 && rect.height < 8) {
                return [];
            }
            if (thumbnailMode === "fit") {
                const layout = masonryLayoutRef.current;
                return layout ?
                    masonryItemsInMarquee(layout.items, rect).map((id) => Number(id)) :
                    [];
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
        [files, galleryColumns, thumbnailMode, gridWidth],
    );

    const getBaselineIds = useCallback(
        (): Iterable<number> =>
            selection?.observeStoreSelection ?
                useSelectionStore.getState().selectedIds :
                (selection?.selectedIds ?? []),
        [selection?.observeStoreSelection, selection?.selectedIds],
    );

    const { containerProps, overlayProps } = useGridMarquee({
        resolveIds: resolveMarqueeFileIds,
        selection,
        getBaselineIds,
        scrollControllerRef,
        footerInsetPx,
    });

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
            {...containerProps}
            className="relative min-h-0 flex-1 select-none overflow-hidden"
            style={{
                // Scrollers are pan-y; an armed marquee blocks the pan itself
                // (see use-marquee-selection).
                pointerEvents: interactionsReady ? "auto" : "none",
            }}
        >
            <AutoSizer
                onResize={({ width }: { width: number }) => {
                    setGridWidth(width);
                }}
            >
                {({ height, width }: { height: number; width: number }) =>
                    thumbnailMode === "fit" ? (
                        <SizedMasonryGrid
                            files={files}
                            width={width}
                            height={height}
                            columns={galleryColumns}
                            chrome={chrome}
                            footerInsetPx={footerInsetPx}
                            scrollControllerRef={scrollControllerRef}
                            layoutRef={masonryLayoutRef}
                            viewOrderKey={viewOrderKey}
                        />
                    ) : (
                        <SizedGrid
                            files={files}
                            width={width}
                            height={height}
                            columns={galleryColumns}
                            chrome={chrome}
                            footerInsetPx={footerInsetPx}
                            listRef={listRef}
                            scrollControllerRef={scrollControllerRef}
                        />
                    )}
            </AutoSizer>
            <div {...overlayProps} />
        </div>
    );
});
