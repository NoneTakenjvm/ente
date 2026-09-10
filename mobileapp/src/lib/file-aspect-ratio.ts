import type { EnteFile } from "ente-media/file";

/** Pixel width and height from public magic metadata when both are valid. */
export type FilePixelSize = { width: number; height: number };

/**
 * Return pixel width / height from public magic metadata, or `undefined`
 * when missing or invalid.
 */
export const filePixelSize = (file: EnteFile): FilePixelSize | undefined => {
    const data = file.pubMagicMetadata?.data;
    const width = data?.w;
    const height = data?.h;
    if (
        typeof width !== "number" ||
        typeof height !== "number" ||
        width <= 0 ||
        height <= 0
    ) {
        return undefined;
    }
    return { width, height };
};

/**
 * Return width / height from public magic metadata, or 1 when unknown.
 */
export const fileAspectRatio = (file: EnteFile): number => {
    const size = filePixelSize(file);
    if (!size) {
        return 1;
    }
    return size.width / size.height;
};

/**
 * Pixel area (width × height) from public magic metadata, or 0 when unknown.
 */
export const filePixelArea = (file: EnteFile): number => {
    const size = filePixelSize(file);
    if (!size) {
        return 0;
    }
    return size.width * size.height;
};
