import type { EnteFile } from "ente-media/file";

/**
 * Return width / height from public magic metadata, or 1 when unknown.
 */
export const fileAspectRatio = (file: EnteFile): number => {
    const data = file.pubMagicMetadata?.data;
    const width = data?.w;
    const height = data?.h;
    if (
        typeof width !== "number" ||
        typeof height !== "number" ||
        width <= 0 ||
        height <= 0
    ) {
        return 1;
    }
    return width / height;
};

/**
 * Pixel area (width × height) from public magic metadata, or 0 when unknown.
 */
export const filePixelArea = (file: EnteFile): number => {
    const data = file.pubMagicMetadata?.data;
    const width = data?.w;
    const height = data?.h;
    if (
        typeof width !== "number" ||
        typeof height !== "number" ||
        width <= 0 ||
        height <= 0
    ) {
        return 0;
    }
    return width * height;
};
