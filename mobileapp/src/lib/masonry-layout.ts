import type { GalleryColumnCount } from "@/lib/app-settings";
import { fileAspectRatio } from "@/lib/file-aspect-ratio";
import { thumbnailGap } from "@/lib/thumbnail-grid-layout";
import type { EnteFile } from "ente-media/file";

export interface MasonryItemLayout {
    fileId: number;
    file: EnteFile;
    key: number;
    /** Index into the files array this layout was built from. */
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface MasonryLayout {
    items: MasonryItemLayout[];
    /** Same objects as {@link items}, grouped by column (increasing y). */
    itemsByColumn: MasonryItemLayout[][];
    totalHeight: number;
    paddingInline: number;
    gap: number;
}

const paddingInlineForWidth = (containerWidth: number): number =>
    containerWidth > 480 ? 16 : 4;

interface MasonryPlacement<T> {
    value: T;
    key: string | number;
    aspectRatio: number;
}

interface PlacedMasonryItem<T> {
    value: T;
    key: string | number;
    x: number;
    y: number;
    width: number;
    height: number;
}

const computePlacedMasonryItems = <T>(
    entries: MasonryPlacement<T>[],
    containerWidth: number,
    columns: GalleryColumnCount,
): {
    items: PlacedMasonryItem<T>[];
    totalHeight: number;
    paddingInline: number;
    gap: number;
} => {
    const paddingInline = paddingInlineForWidth(containerWidth);
    const gap = thumbnailGap;
    const available = containerWidth - paddingInline * 2;
    const columnWidth = (available - gap * (columns - 1)) / columns;
    const columnHeights = Array.from({ length: columns }, () => 0);
    const items: PlacedMasonryItem<T>[] = [];

    for (const entry of entries) {
        const height = columnWidth / entry.aspectRatio;
        let column = 0;
        for (let index = 1; index < columns; index += 1) {
            if (columnHeights[index] < columnHeights[column]) {
                column = index;
            }
        }
        const x = paddingInline + column * (columnWidth + gap);
        const y = columnHeights[column];
        items.push({
            value: entry.value,
            key: entry.key,
            x,
            y,
            width: columnWidth,
            height,
        });
        columnHeights[column] += height + gap;
    }

    let tallest = 0;
    for (const columnHeight of columnHeights) {
        if (columnHeight > tallest) {
            tallest = columnHeight;
        }
    }
    const totalHeight =
        items.length > 0 ? tallest - gap : 0;

    return {
        items,
        totalHeight: Math.max(0, totalHeight),
        paddingInline,
        gap,
    };
};

/**
 * Place files in a column masonry layout with fixed column count.
 */
export const computeMasonryLayout = (
    files: EnteFile[],
    containerWidth: number,
    columns: GalleryColumnCount,
): MasonryLayout => {
    const paddingInline = paddingInlineForWidth(containerWidth);
    const gap = thumbnailGap;
    const available = containerWidth - paddingInline * 2;
    const columnWidth = (available - gap * (columns - 1)) / columns;
    const columnHeights = Array.from({ length: columns }, () => 0);
    const items: MasonryItemLayout[] = [];
    const itemsByColumn: MasonryItemLayout[][] = Array.from(
        { length: columns },
        () => [],
    );

    for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!;
        const height = columnWidth / fileAspectRatio(file);
        let column = 0;
        for (let next = 1; next < columns; next += 1) {
            if (columnHeights[next]! < columnHeights[column]!) {
                column = next;
            }
        }
        const item: MasonryItemLayout = {
            fileId: file.id,
            file,
            key: file.id,
            index,
            x: paddingInline + column * (columnWidth + gap),
            y: columnHeights[column]!,
            width: columnWidth,
            height,
        };
        items.push(item);
        itemsByColumn[column]!.push(item);
        columnHeights[column] += height + gap;
    }

    let tallest = 0;
    for (const columnHeight of columnHeights) {
        if (columnHeight > tallest) {
            tallest = columnHeight;
        }
    }
    const totalHeight = items.length > 0 ? tallest - gap : 0;

    return {
        items,
        itemsByColumn,
        totalHeight: Math.max(0, totalHeight),
        paddingInline,
        gap,
    };
};

export const computeMasonryLayoutFromAspects = <T>(
    entries: Array<{ value: T; key: string | number; aspectRatio: number }>,
    containerWidth: number,
    columns: GalleryColumnCount,
): {
    items: PlacedMasonryItem<T>[];
    totalHeight: number;
    paddingInline: number;
    gap: number;
} => computePlacedMasonryItems(entries, containerWidth, columns);

export const masonryItemsInMarquee = (
    items: Array<{ key: string | number; x: number; y: number; width: number; height: number }>,
    scrollTop: number,
    rect: { x: number; y: number; width: number; height: number },
): Array<string | number> => {
    const keys: Array<string | number> = [];
    for (const item of items) {
        const itemTop = item.y - scrollTop;
        const itemBottom = itemTop + item.height;
        const itemLeft = item.x;
        const itemRight = itemLeft + item.width;
        const overlaps =
            itemRight >= rect.x &&
            itemLeft <= rect.x + rect.width &&
            itemBottom >= rect.y &&
            itemTop <= rect.y + rect.height;
        if (overlaps) {
            keys.push(item.key);
        }
    }
    return keys;
};

/**
 * Group masonry items into columns (same x). Placement order is increasing y
 * within each column, so callers can binary-search the visible range.
 */
export const groupMasonryItemsByColumn = <
    T extends { x: number; y: number; height: number },
>(
    items: T[],
): T[][] => {
    const columns: T[][] = [];
    const indexByX = new Map<number, number>();
    for (const item of items) {
        let columnIndex = indexByX.get(item.x);
        if (columnIndex === undefined) {
            columnIndex = columns.length;
            indexByX.set(item.x, columnIndex);
            columns.push([item]);
            continue;
        }
        columns[columnIndex]!.push(item);
    }
    return columns;
};

const firstIndexWhere = <T>(
    items: readonly T[],
    predicate: (item: T) => boolean,
): number => {
    let low = 0;
    let high = items.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (predicate(items[mid]!)) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    return low;
};

/**
 * Visible slice of a y-increasing column (item.y + height is also increasing
 * because each item is stacked with a gap).
 */
const visibleItemsInColumn = <T extends { y: number; height: number }>(
    column: readonly T[],
    minY: number,
    maxY: number,
): T[] => {
    if (column.length === 0) {
        return [];
    }
    const start = firstIndexWhere(
        column,
        (item) => item.y + item.height >= minY,
    );
    const end = firstIndexWhere(column, (item) => item.y > maxY);
    if (start >= end) {
        return [];
    }
    return column.slice(start, end);
};

/** Collect visible items from pre-grouped columns. */
export const visibleMasonryItemsFromColumns = <
    T extends { y: number; height: number },
>(
    columns: readonly (readonly T[])[],
    scrollTop: number,
    viewportHeight: number,
    overscanPx = 200,
): T[] => {
    const minY = scrollTop - overscanPx;
    const maxY = scrollTop + viewportHeight + overscanPx;
    const visible: T[] = [];
    for (const column of columns) {
        const slice = visibleItemsInColumn(column, minY, maxY);
        for (const item of slice) {
            visible.push(item);
        }
    }
    return visible;
};

export const visibleMasonryItems = <
    T extends { x: number; y: number; height: number },
>(
    items: T[],
    scrollTop: number,
    viewportHeight: number,
    overscanPx = 200,
): T[] => {
    const minY = scrollTop - overscanPx;
    const maxY = scrollTop + viewportHeight + overscanPx;
    if (items.length < 64) {
        return items.filter(
            (item) => item.y + item.height >= minY && item.y <= maxY,
        );
    }
    return visibleMasonryItemsFromColumns(
        groupMasonryItemsByColumn(items),
        scrollTop,
        viewportHeight,
        overscanPx,
    );
};
