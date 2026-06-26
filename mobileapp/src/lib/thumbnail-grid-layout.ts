import type { GalleryColumnCount } from "@/lib/app-settings";

export const thumbnailGap: number = 4;

export interface ThumbnailGridLayout {
    columns: number;
    itemSize: number;
    gap: number;
    paddingInline: number;
    rowHeight: number;
}

export const computeThumbnailGridLayout = (
    containerWidth: number,
    columns: GalleryColumnCount,
): ThumbnailGridLayout => {
    const paddingInline: number = containerWidth > 480 ? 16 : 4;
    const gap: number = thumbnailGap;
    const available: number = containerWidth - paddingInline * 2;
    const itemSize: number = Math.floor(
        (available - gap * (columns - 1)) / columns,
    );
    const rowHeight: number = itemSize + gap;

    return { columns, itemSize, gap, paddingInline, rowHeight };
};

export const rowCountForFiles = (
    fileCount: number,
    columns: number,
): number => Math.ceil(fileCount / columns);
