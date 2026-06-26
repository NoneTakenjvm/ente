import type { GalleryColumnCount } from "@/lib/app-settings";
import { fileAspectRatio } from "@/lib/file-aspect-ratio";
import { thumbnailGap } from "@/lib/thumbnail-grid-layout";
import type { EnteFile } from "ente-media/file";

export interface MasonryItemLayout {
    fileId: number;
    file: EnteFile;
    key: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface MasonryLayout {
    items: MasonryItemLayout[];
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

    const totalHeight =
        items.length > 0 ?
            Math.max(...columnHeights) - gap :
            0;

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
    const placed = computePlacedMasonryItems(
        files.map((file) => ({
            value: file,
            key: file.id,
            aspectRatio: fileAspectRatio(file),
        })),
        containerWidth,
        columns,
    );

    return {
        items: placed.items.map((item) => ({
            fileId: item.value.id,
            file: item.value,
            key: item.value.id,
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
        })),
        totalHeight: placed.totalHeight,
        paddingInline: placed.paddingInline,
        gap: placed.gap,
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

export const visibleMasonryItems = <T extends { y: number; height: number }>(
    items: T[],
    scrollTop: number,
    viewportHeight: number,
    overscanPx = 200,
): T[] => {
    const minY = scrollTop - overscanPx;
    const maxY = scrollTop + viewportHeight + overscanPx;
    return items.filter(
        (item) => item.y + item.height >= minY && item.y <= maxY,
    );
};
