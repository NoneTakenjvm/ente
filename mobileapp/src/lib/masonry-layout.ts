import type { GalleryColumnCount } from "@/lib/app-settings";
import type { GridSection } from "@/lib/date-sections";
import { fileAspectRatio, filePixelSize } from "@/lib/file-aspect-ratio";
import { thumbnailGap } from "@/lib/thumbnail-grid-layout";
import type { EnteFile } from "ente-media/file";

interface MasonryItemLayout {
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

interface MasonrySectionHeader {
    label: string;
    y: number;
    height: number;
}

interface MasonryLayoutOptions {
    sections?: readonly GridSection[];
    /** Tiles are square, so shortest-column placement fills each row left to right. */
    squareTiles?: boolean;
}

export interface MasonryLayout {
    items: MasonryItemLayout[];
    /** Same objects as {@link items}, grouped by column (increasing y). */
    itemsByColumn: MasonryItemLayout[][];
    /** One per section, in increasing y; empty without sections. */
    headers: MasonrySectionHeader[];
    totalHeight: number;
    paddingInline: number;
    gap: number;
}

/**
 * Order and geometry fingerprint for masonry layout reuse — O(n) integer hash,
 * no giant comma-joined id string allocation on every `files` reference change.
 * Pixel width/height are included because an in-place edit can change a tile's height.
 */
export const masonryViewOrderKey = (files: readonly EnteFile[]): string => {
    let hash = files.length | 0;
    for (const file of files) {
        const size = filePixelSize(file);
        hash = (Math.imul(hash, 31) + file.id) | 0;
        hash = (Math.imul(hash, 31) + (size?.width ?? 0)) | 0;
        hash = (Math.imul(hash, 31) + (size?.height ?? 0)) | 0;
    }
    return `${files.length}:${hash}`;
};

/** Height of a section header row, in px. */
const MASONRY_SECTION_HEADER_HEIGHT = 36;

const paddingInlineForWidth = (containerWidth: number): number =>
    containerWidth > 480 ? 16 : 4;

/**
 * Place files in a column masonry layout with fixed column count. With
 * `sections`, each section gets a header row that levels all columns first.
 */
export const computeMasonryLayout = (
    files: EnteFile[],
    containerWidth: number,
    columns: GalleryColumnCount,
    { sections = [], squareTiles = false }: MasonryLayoutOptions = {},
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
    const headers: MasonrySectionHeader[] = [];
    const sectionLabelByStart = new Map(
        sections.map((section) => [section.start, section.label] as const),
    );

    for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!;
        const sectionLabel = sectionLabelByStart.get(index);
        if (sectionLabel !== undefined) {
            // Start the section below the tallest column so no earlier tile is overlapped.
            const top = Math.max(...columnHeights);
            headers.push({
                label: sectionLabel,
                y: top,
                height: MASONRY_SECTION_HEADER_HEIGHT,
            });
            columnHeights.fill(top + MASONRY_SECTION_HEADER_HEIGHT);
        }
        const height = squareTiles ?
            columnWidth :
            columnWidth / fileAspectRatio(file);
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
        headers,
        totalHeight: Math.max(0, totalHeight),
        paddingInline,
        gap,
    };
};

/**
 * Keys whose placed boxes intersect a content-space marquee rect.
 * {@link rect} uses the same coordinate system as item `x`/`y` (not viewport).
 */
export const masonryItemsInMarquee = (
    items: Array<{
        key: string | number;
        x: number;
        y: number;
        width: number;
        height: number;
    }>,
    rect: { x: number; y: number; width: number; height: number },
): Array<string | number> => {
    const keys: Array<string | number> = [];
    for (const item of items) {
        const overlaps =
            item.x < rect.x + rect.width &&
            item.x + item.width > rect.x &&
            item.y < rect.y + rect.height &&
            item.y + item.height > rect.y;
        if (overlaps) {
            keys.push(item.key);
        }
    }
    return keys;
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
