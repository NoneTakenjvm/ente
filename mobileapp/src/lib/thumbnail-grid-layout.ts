export const thumbnailGap: number = 4;
export const thumbnailMaxSize: number = 120;

export interface ThumbnailGridLayout {
    columns: number;
    itemSize: number;
    gap: number;
    paddingInline: number;
    rowHeight: number;
}

export const computeThumbnailGridLayout = (
    containerWidth: number,
): ThumbnailGridLayout => {
    const paddingInline: number = containerWidth > 480 ? 16 : 4;
    const gap: number = thumbnailGap;
    const available: number = containerWidth - paddingInline * 2;
    const minColumns: number = 3;
    const maxColumns: number = 5;
    const itemSize: number = Math.min(
        thumbnailMaxSize,
        Math.floor((available - gap * (minColumns - 1)) / minColumns),
    );
    let columns: number = Math.floor((available + gap) / (itemSize + gap));
    columns = Math.max(minColumns, Math.min(maxColumns, columns));
    const rowHeight: number = itemSize + gap;

    return { columns, itemSize, gap, paddingInline, rowHeight };
};

export const rowCountForFiles = (
    fileCount: number,
    columns: number,
): number => Math.ceil(fileCount / columns);
