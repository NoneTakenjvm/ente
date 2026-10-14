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
} from "react";
import AutoSizer from "react-virtualized-auto-sizer";
import {
    FixedSizeList,
    type ListChildComponentProps,
} from "react-window";
import { SelectedTileOverlay } from "@/components/ThumbnailCell";
import type { GalleryColumnCount } from "@/lib/app-settings";
import {
    gridIndicesInContentMarquee,
    type MarqueeRect,
} from "@/lib/marquee-selection";
import { stagingPreviewUrl } from "@/lib/staging-preview";
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
    /** Original image; when set, the cell shows a downscaled copy instead of {@link previewUrl}. */
    file?: Blob;
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
    isSelected: boolean;
    onToggle: (id: string) => void;
    disabled: boolean;
}

/**
 * Image `src` for a cell. Items with a {@link LocalUploadItem.file} get a
 * downscaled decode so the grid never holds full-size originals; the
 * original preview is used only if that decode fails.
 */
const useCellImageSrc = (
    item: LocalUploadItem,
    width: number,
): string | undefined => {
    const { file } = item;
    const [downscaledUrl, setDownscaledUrl] = useState<string | undefined>();
    const [decodeFailed, setDecodeFailed] = useState(false);

    useEffect(() => {
        if (!file) {
            return;
        }
        const controller = new AbortController();
        let objectUrl: string | undefined;
        stagingPreviewUrl(file, width, controller.signal)
            .then((url) => {
                if (controller.signal.aborted) {
                    URL.revokeObjectURL(url);
                    return;
                }
                objectUrl = url;
                setDownscaledUrl(url);
            })
            .catch(() => {
                if (!controller.signal.aborted) {
                    setDecodeFailed(true);
                }
            });
        return () => {
            controller.abort();
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
            setDownscaledUrl(undefined);
            setDecodeFailed(false);
        };
    }, [file, width]);

    if (!file) {
        return item.previewUrl;
    }
    return downscaledUrl ?? (decodeFailed ? item.previewUrl : undefined);
};

const LocalUploadCell = memo(function LocalUploadCell({
    item,
    width,
    height,
    isSelected,
    onToggle,
    disabled,
}: LocalUploadCellProps): JSX.Element {
    const imageSrc = useCellImageSrc(item, width);

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
                            "pointer-events-none size-full object-cover",
                        )}
                        src={item.previewUrl}
                        muted
                        playsInline
                        preload="metadata"
                    />
                ) : (
                    <img
                        className={cn(
                            "pointer-events-none size-full object-cover",
                        )}
                        src={imageSrc}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                    />
                )}
            </button>
            {isSelected ? <SelectedTileOverlay /> : null}
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
    const outerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        scrollControllerRef.current = {
            getScrollTop: (): number => scrollOffsetRef.current,
            setScrollTop: (next: number): void => {
                const outer = outerRef.current;
                const maxScroll =
                    outer ? Math.max(0, outer.scrollHeight - outer.clientHeight) : 0;
                const clamped = Math.min(Math.max(0, next), maxScroll);
                if (clamped === scrollOffsetRef.current) {
                    return;
                }
                scrollOffsetRef.current = clamped;
                listRef.current?.scrollTo(clamped);
            },
        };
        return (): void => {
            scrollControllerRef.current = null;
        };
    }, [listRef, scrollControllerRef]);

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
            onScroll={(props) => {
                scrollOffsetRef.current = props.scrollOffset;
            }}
            style={{ paddingBottom: footerInsetPx, touchAction: "pan-y" }}
        >
            {GridRow}
        </FixedSizeList>
    );
}

export function LocalUploadGrid({
    items,
    selection,
    footerInsetPx = 0,
}: LocalUploadGridProps): JSX.Element {
    const galleryColumns = useSettingsStore((s) => s.galleryColumns);
    const listRef = useRef<FixedSizeList<RowData>>(null);
    const scrollControllerRef = useRef<MarqueeScrollController | null>(null);
    const marqueeBaselineRef = useRef<Set<string>>(new Set());
    const marqueeAppliedIdsRef = useRef<Set<string>>(new Set());
    const marqueeLastIdsRef = useRef<string[]>([]);
    const [gridWidth, setGridWidth] = useState<number>(0);

    const resolveMarqueeItemIds = useCallback(
        (rect: MarqueeRect): string[] => {
            if (rect.width < 8 && rect.height < 8) {
                return [];
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
        [galleryColumns, gridWidth, items],
    );

    const handleMarqueeRect = useCallback(
        (rect: MarqueeRect): void => {
            if (!selection.onSelectMany) {
                return;
            }
            const itemIds = resolveMarqueeItemIds(rect);
            if (sameIds(itemIds, marqueeLastIdsRef.current)) {
                return;
            }
            marqueeLastIdsRef.current = itemIds;
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
        containerRef,
        overlayRef,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
    } = useMarqueeSelection({
        enabled: marqueeEnabled,
        scrollControllerRef,
        onMarqueeRect: handleMarqueeRect,
        bottomInsetPx: footerInsetPx,
    });

    const handlePointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>): void => {
            marqueeBaselineRef.current = new Set(selection.selectedIds);
            marqueeAppliedIdsRef.current = new Set();
            marqueeLastIdsRef.current = [];
            onPointerDown(event);
        },
        [onPointerDown, selection.selectedIds],
    );

    return (
        <div
            ref={containerRef}
            className="relative min-h-0 flex-1 select-none overflow-hidden"
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
                {({ height, width }: { height: number; width: number }) => (
                    <SizedGrid
                        items={items}
                        width={width}
                        height={height}
                        columns={galleryColumns}
                        selection={selection}
                        footerInsetPx={footerInsetPx}
                        listRef={listRef}
                        scrollControllerRef={scrollControllerRef}
                    />
                )}
            </AutoSizer>
            <div
                ref={overlayRef}
                className="pointer-events-none absolute z-30 border border-primary bg-primary/20"
                style={{ display: "none" }}
            />
        </div>
    );
}

const sameIds = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((id, index) => id === b[index]);
