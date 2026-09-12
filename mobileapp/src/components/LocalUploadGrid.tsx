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
import { Check } from "lucide-react";
import type { GalleryColumnCount } from "@/lib/app-settings";
import {
    gridIndicesInContentMarquee,
    type MarqueeRect,
} from "@/lib/marquee-selection";
import {
    computeMasonryLayoutFromAspects,
    masonryItemsInMarquee,
    visibleMasonryItems,
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
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";

export interface LocalUploadItem {
    id: string;
    previewUrl: string;
    label: string;
    kind?: "image" | "video";
}

export interface LocalUploadGridSelection {
    selectedIds: Set<string>;
    onToggle: (id: string) => void;
    onSelectMany?: (ids: string[], mode: "add" | "toggle" | "set") => void;
    /** When set, marquee is baseline ∪ live intersection (retract deselects). */
    onSetSelection?: (ids: string[]) => void;
    disabled?: boolean;
}

interface LocalUploadGridProps {
    items: LocalUploadItem[];
    selection: LocalUploadGridSelection;
    footerInsetPx?: number;
}

interface RowData {
    items: LocalUploadItem[];
    layout: ThumbnailGridLayout;
    selection: LocalUploadGridSelection;
}

interface LocalUploadCellProps {
    item: LocalUploadItem;
    width: number;
    height: number;
    objectFit: "cover" | "contain";
    isSelected: boolean;
    onToggle: (id: string) => void;
    disabled: boolean;
}

const LocalUploadCell = memo(function LocalUploadCell({
    item,
    width,
    height,
    objectFit,
    isSelected,
    onToggle,
    disabled,
}: LocalUploadCellProps): JSX.Element {
    const imageFitClass =
        objectFit === "contain" ? "object-contain" : "object-cover";

    return (
        <div
            className={cn(
                "relative shrink-0 overflow-hidden rounded-md bg-muted",
                disabled && "pointer-events-none opacity-50",
            )}
            style={{ width, height }}
        >
            <button
                type="button"
                className="size-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => {
                    if (!disabled) {
                        onToggle(item.id);
                    }
                }}
                disabled={disabled}
                aria-label={
                    isSelected ?
                        `Deselect ${item.label}` :
                        `Select ${item.label}`
                }
                aria-pressed={isSelected}
            >
                {item.kind === "video" ? (
                    <video
                        className={cn(
                            "pointer-events-none size-full",
                            imageFitClass,
                        )}
                        src={item.previewUrl}
                        muted
                        playsInline
                        preload="metadata"
                    />
                ) : (
                    <img
                        className={cn(
                            "pointer-events-none size-full",
                            imageFitClass,
                        )}
                        src={item.previewUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                    />
                )}
            </button>
            {isSelected ? (
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
            ) : null}
        </div>
    );
});

const GridRow = memo(function GridRow({
    index,
    style,
    data,
}: ListChildComponentProps<RowData>): JSX.Element {
    const { items, layout, selection } = data;
    const start = index * layout.columns;
    const rowItems = items.slice(start, start + layout.columns);

    return (
        <div
            className="flex w-full"
            style={{
                ...style,
                paddingInline: layout.paddingInline,
                gap: layout.gap,
            }}
        >
            {rowItems.map((item) => (
                <LocalUploadCell
                    key={item.id}
                    item={item}
                    width={layout.itemSize}
                    height={layout.itemSize}
                    objectFit="cover"
                    isSelected={selection.selectedIds.has(item.id)}
                    onToggle={selection.onToggle}
                    disabled={selection.disabled ?? false}
                />
            ))}
        </div>
    );
});

interface SizedGridProps {
    items: LocalUploadItem[];
    width: number;
    height: number;
    columns: GalleryColumnCount;
    selection: LocalUploadGridSelection;
    footerInsetPx: number;
    onScrollOffsetChange: (offset: number) => void;
    listRef: RefObject<FixedSizeList<RowData> | null>;
    scrollControllerRef: RefObject<MarqueeScrollController | null>;
}

function SizedGrid({
    items,
    width,
    height,
    columns,
    selection,
    footerInsetPx,
    onScrollOffsetChange,
    listRef,
    scrollControllerRef,
}: SizedGridProps): JSX.Element {
    const layout = useMemo(
        () => computeThumbnailGridLayout(width, columns),
        [columns, width],
    );
    const rowCount = rowCountForFiles(items.length, layout.columns);
    const itemData: RowData = useMemo(
        () => ({ items, layout, selection }),
        [items, layout, selection],
    );
    const scrollOffsetRef = useRef(0);

    useEffect(() => {
        scrollControllerRef.current = {
            getScrollTop: (): number => scrollOffsetRef.current,
            setScrollTop: (next: number): void => {
                const clamped = Math.max(0, next);
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
            onScroll={(props) => {
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
    items: LocalUploadItem[];
    width: number;
    height: number;
    columns: GalleryColumnCount;
    selection: LocalUploadGridSelection;
    footerInsetPx: number;
    onScrollOffsetChange: (offset: number) => void;
    scrollControllerRef: RefObject<MarqueeScrollController | null>;
}

function SizedMasonryGrid({
    items,
    width,
    height,
    columns,
    selection,
    footerInsetPx,
    onScrollOffsetChange,
    scrollControllerRef,
}: SizedMasonryGridProps): JSX.Element {
    const [scrollTop, setScrollTop] = useState<number>(0);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const layout = useMemo(
        () =>
            computeMasonryLayoutFromAspects(
                items.map((item) => ({
                    value: item,
                    key: item.id,
                    aspectRatio: 1,
                })),
                width,
                columns,
            ),
        [columns, items, width],
    );
    const visibleItems = useMemo(
        () => visibleMasonryItems(layout.items, scrollTop, height),
        [height, layout.items, scrollTop],
    );

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
            setScrollTop(nextScrollTop);
            onScrollOffsetChange(nextScrollTop);
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
                    height: layout.totalHeight + footerInsetPx,
                }}
            >
                {visibleItems.map((item) => (
                    <div
                        key={item.key}
                        className="absolute"
                        style={{
                            left: item.x,
                            top: item.y,
                            width: item.width,
                            height: item.height,
                        }}
                    >
                        <LocalUploadCell
                            item={item.value}
                            width={item.width}
                            height={item.height}
                            objectFit="contain"
                            isSelected={selection.selectedIds.has(item.value.id)}
                            onToggle={selection.onToggle}
                            disabled={selection.disabled ?? false}
                        />
                    </div>
                ))}
            </div>
        </div>
    );
}

export function LocalUploadGrid({
    items,
    selection,
    footerInsetPx = 0,
}: LocalUploadGridProps): JSX.Element {
    const galleryColumns = useSettingsStore((s) => s.galleryColumns);
    const galleryThumbnailMode = useSettingsStore((s) => s.galleryThumbnailMode);
    const listRef = useRef<FixedSizeList<RowData>>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollControllerRef = useRef<MarqueeScrollController | null>(null);
    const marqueeBaselineRef = useRef<Set<string>>(new Set());
    const marqueeAppliedIdsRef = useRef<Set<string>>(new Set());
    const [gridWidth, setGridWidth] = useState<number>(0);

    const handleScrollOffsetChange = useCallback((_offset: number): void => {
        // Scroll offset is owned by scrollControllerRef inside the sized grids.
    }, []);

    const resolveMarqueeItemIds = useCallback(
        (rect: MarqueeRect): string[] => {
            if (rect.width < 8 && rect.height < 8) {
                return [];
            }
            if (galleryThumbnailMode === "fit") {
                const layout = computeMasonryLayoutFromAspects(
                    items.map((item) => ({
                        value: item,
                        key: item.id,
                        aspectRatio: 1,
                    })),
                    gridWidth,
                    galleryColumns,
                );
                return masonryItemsInMarquee(layout.items, rect).map((id) => String(id));
            }
            const layout = computeThumbnailGridLayout(gridWidth, galleryColumns);
            const indices = gridIndicesInContentMarquee(
                items.length,
                layout.columns,
                layout.rowHeight,
                layout.itemSize,
                layout.paddingInline,
                layout.gap,
                rect,
            );
            return indices.map((index) => items[index]!.id);
        },
        [galleryColumns, galleryThumbnailMode, gridWidth, items],
    );

    const handleMarqueeRect = useCallback(
        (rect: MarqueeRect): void => {
            if (!selection.onSelectMany) {
                return;
            }
            const itemIds = resolveMarqueeItemIds(rect);
            if (selection.onSetSelection) {
                const next = new Set(marqueeBaselineRef.current);
                for (const id of itemIds) {
                    next.add(id);
                }
                selection.onSetSelection([...next]);
                return;
            }
            const fresh: string[] = [];
            for (const id of itemIds) {
                if (!marqueeAppliedIdsRef.current.has(id)) {
                    marqueeAppliedIdsRef.current.add(id);
                    fresh.push(id);
                }
            }
            if (fresh.length > 0) {
                selection.onSelectMany(fresh, "add");
            }
        },
        [resolveMarqueeItemIds, selection],
    );

    const marqueeEnabled =
        Boolean(selection.onSelectMany) && !selection.disabled;

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
            marqueeBaselineRef.current = new Set(selection.selectedIds);
            marqueeAppliedIdsRef.current = new Set();
            onPointerDown(event);
        },
        [onPointerDown, selection.selectedIds],
    );

    return (
        <div
            ref={containerRef}
            className="relative min-h-0 flex-1 select-none overflow-hidden"
            style={{ touchAction: marqueeEnabled ? "none" : "pan-y" }}
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
                            items={items}
                            width={width}
                            height={height}
                            columns={galleryColumns}
                            selection={selection}
                            footerInsetPx={footerInsetPx}
                            onScrollOffsetChange={handleScrollOffsetChange}
                            scrollControllerRef={scrollControllerRef}
                        />
                    ) : (
                        <SizedGrid
                            items={items}
                            width={width}
                            height={height}
                            columns={galleryColumns}
                            selection={selection}
                            footerInsetPx={footerInsetPx}
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
}
