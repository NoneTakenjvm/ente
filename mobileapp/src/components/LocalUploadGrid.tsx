import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
    type RefObject,
} from "react";
import AutoSizer from "react-virtualized-auto-sizer";
import {
    FixedSizeList,
    type ListChildComponentProps,
} from "react-window";
import { SelectedTileOverlay, TileFrame } from "@/components/ThumbnailCell";
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
import { useGridMarquee } from "@/hooks/use-grid-marquee";
import { useListScrollController } from "@/hooks/use-list-scroll-controller";
import type { MarqueeScrollController } from "@/hooks/use-marquee-selection";
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

interface LocalUploadGridSelection {
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
        <TileFrame width={width} height={height} disabled={disabled}>
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
        </TileFrame>
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
            onScroll={onScroll}
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

    const getBaselineIds = useCallback(
        (): Iterable<string> => selection.selectedIds,
        [selection.selectedIds],
    );

    const { containerProps, overlayProps } = useGridMarquee({
        resolveIds: resolveMarqueeItemIds,
        selection,
        getBaselineIds,
        scrollControllerRef,
        footerInsetPx,
    });

    return (
        <div
            {...containerProps}
            className="relative min-h-0 flex-1 select-none overflow-hidden"
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
            <div {...overlayProps} />
        </div>
    );
}
