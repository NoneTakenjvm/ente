import { lowercaseExtension } from "ente-base/file-name";
import { FileType } from "ente-media/file-type";
import { fileFileName } from "ente-media/file-metadata";
import { isHEICExtension } from "ente-media/formats";
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
    if (
        file.metadata.fileType === FileType.image ||
        file.metadata.fileType === FileType.livePhoto
    ) {
        return isGifFile(file) ? "gif" : "image";
    }
    return null;
};

export const mimeTypeForFile = (file: EnteFile): string => {
    const kind = mediaKindForFile(file);
    const name = fileFileName(file);
    const extension = lowercaseExtension(name) ?? "";
    if (kind === "video") {
        if (extension === "webm") {
            return "video/webm";
        }
        if (extension === "mov") {
            return "video/quicktime";
        }
        return "video/mp4";
    }
    if (kind === "gif" || extension === "gif") {
        return "image/gif";
    }
    if (extension === "png") {
        return "image/png";
    }
    if (extension === "webp") {
        return "image/webp";
    }
    if (isHEICExtension(extension)) {
        return "image/heic";
    }
    return "image/jpeg";
};
