import { memo, useCallback, useMemo, useRef, useState, type JSX, type RefObject } from "react";
import AutoSizer from "react-virtualized-auto-sizer";
import {
    FixedSizeList,
    type ListChildComponentProps,
} from "react-window";
import { Check } from "lucide-react";
import { resolveMarqueeDragIntent } from "@/lib/compress";
import {
    computeThumbnailGridLayout,
    rowCountForFiles,
    type ThumbnailGridLayout,
} from "@/lib/thumbnail-grid-layout";
import { cn } from "@/lib/utils";

export interface LocalUploadItem {
    id: string;
    previewUrl: string;
    label: string;
}

export interface LocalUploadGridSelection {
    selectedIds: Set<string>;
    onToggle: (id: string) => void;
    onSelectMany?: (ids: string[], mode: "add" | "toggle") => void;
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
    size: number;
    isSelected: boolean;
    onToggle: (id: string) => void;
    disabled: boolean;
}

const LocalUploadCell = memo(function LocalUploadCell({
    item,
    size,
    isSelected,
    onToggle,
    disabled,
}: LocalUploadCellProps): JSX.Element {
    return (
        <div
            className={cn(
                "relative shrink-0 overflow-hidden rounded-md bg-muted",
                disabled && "pointer-events-none opacity-50",
            )}
            style={{ width: size, height: size }}
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
                <img
                    className="pointer-events-none size-full object-cover"
                    src={item.previewUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                />
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
                    size={layout.itemSize}
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
    selection: LocalUploadGridSelection;
    footerInsetPx: number;
    onScrollOffsetChange: (offset: number) => void;
    listRef: RefObject<FixedSizeList<RowData> | null>;
}

function SizedGrid({
    items,
    width,
    height,
    selection,
    footerInsetPx,
    onScrollOffsetChange,
    listRef,
}: SizedGridProps): JSX.Element {
    const layout = useMemo(
        () => computeThumbnailGridLayout(width),
        [width],
    );
    const rowCount = rowCountForFiles(items.length, layout.columns);
    const itemData: RowData = useMemo(
        () => ({ items, layout, selection }),
        [items, layout, selection],
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

const itemIdsInMarquee = (
    items: LocalUploadItem[],
    layout: ThumbnailGridLayout,
    scrollTop: number,
    rect: MarqueeRect,
): string[] => {
    const ids: string[] = [];
    const rowCount = rowCountForFiles(items.length, layout.columns);
    for (let row = 0; row < rowCount; row += 1) {
        const rowTop = row * layout.rowHeight - scrollTop;
        const rowBottom = rowTop + layout.itemSize;
        if (rowBottom < rect.y || rowTop > rect.y + rect.height) {
            continue;
        }
        for (let col = 0; col < layout.columns; col += 1) {
            const index = row * layout.columns + col;
            if (index >= items.length) {
                break;
            }
            const cellLeft =
                layout.paddingInline + col * (layout.itemSize + layout.gap);
            const cellRight = cellLeft + layout.itemSize;
            const overlaps =
                cellRight >= rect.x &&
                cellLeft <= rect.x + rect.width &&
                rowBottom >= rect.y &&
                rowTop <= rect.y + rect.height;
            if (overlaps) {
                ids.push(items[index].id);
            }
        }
    }
    return ids;
};

export function LocalUploadGrid({
    items,
    selection,
    footerInsetPx = 0,
}: LocalUploadGridProps): JSX.Element {
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
                !selection.onSelectMany ||
                !containerRef.current
            ) {
                return;
            }
            const rect = normalizeRect(start, { x: endX, y: endY });
            if (rect.width < 8 && rect.height < 8) {
                return;
            }
            const layout = computeThumbnailGridLayout(gridWidth);
            const itemIds = itemIdsInMarquee(
                items,
                layout,
                scrollTopRef.current,
                rect,
            );
            if (itemIds.length > 0) {
                selection.onSelectMany(itemIds, "add");
            }
        },
        [gridWidth, items, selection],
    );

    const cancelMarqueeTracking = useCallback((): void => {
        dragStartRef.current = undefined;
        dragIntentRef.current = "pending";
        setMarqueeArmed(false);
        setMarquee(undefined);
    }, []);

    const handlePointerDown = useCallback(
        (event: React.PointerEvent<HTMLDivElement>): void => {
            if (!selection.onSelectMany || selection.disabled) {
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
                        items={items}
                        width={width}
                        height={height}
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
