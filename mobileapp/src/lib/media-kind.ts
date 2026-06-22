import { FileType } from "ente-media/file-type";
import { fileFileName } from "ente-media/file-metadata";
import type { EnteFile } from "ente-media/file";

export type MediaKind = "image" | "gif" | "video";

export const isGifFile = (file: EnteFile): boolean =>
    fileFileName(file).toLowerCase().endsWith(".gif");

/**
 * Classify a library file for transcode and viewer behaviour.
 */
export const mediaKindForFile = (file: EnteFile): MediaKind | null => {
    if (file.metadata.fileType === FileType.video) {
        return "video";
    }
    if (file.metadata.fileType === FileType.image) {
        return isGifFile(file) ? "gif" : "image";
    }
    return null;
};

export const mimeTypeForFile = (file: EnteFile): string => {
    const kind = mediaKindForFile(file);
    if (kind === "video") {
        const name = fileFileName(file).toLowerCase();
        if (name.endsWith(".webm")) {
            return "video/webm";
        }
        if (name.endsWith(".mov")) {
            return "video/quicktime";
        }
        return "video/mp4";
    }
    if (kind === "gif") {
        return "image/gif";
    }
    return "image/jpeg";
};
