import { FileType } from "ente-media/file-type";
import { fileFileName } from "ente-media/file-metadata";
import type { EnteFile } from "ente-media/file";
import { extractTags } from "@/lib/tags";
import { addTagNames } from "@/lib/tag-writes";
import { isGifFile } from "@/lib/media-kind";
import type {
    CompressWorkerRequest,
    CompressWorkerResponse,
} from "@/workers/compress-worker-types";

export const COMPRESSED_TAG = "compressed";

export const DEFAULT_JPEG_QUALITY = 0.85;
export const MIN_JPEG_QUALITY = 0.6;
export const MAX_JPEG_QUALITY = 0.95;

export interface EncodeJpegResult {
    bytes: Uint8Array;
    width: number;
    height: number;
}

export interface SizeDelta {
    originalBytes: number;
    compressedBytes: number;
    savedBytes: number;
    savedPercent: number;
    originalLabel: string;
    compressedLabel: string;
    savedLabel: string;
}

/**
 * Return true when the file is an image or video.
 */
export const isCompressibleMediaType = (file: EnteFile): boolean => {
    const fileType = file.metadata.fileType;
    return fileType === FileType.video || fileType === FileType.image;
};

/**
 * Return true when the file was previously compressed in-place.
 */
export const isAlreadyCompressed = (file: EnteFile): boolean =>
    extractTags(file).includes(COMPRESSED_TAG);

/**
 * Return true when the file can be compressed from the viewer or manage tab.
 */
export const canCompressMedia = (file: EnteFile): boolean =>
    isCompressibleMediaType(file);

export const canCompress = (file: EnteFile): boolean => canCompressMedia(file);

/**
 * Files eligible for bulk compression on the manage tab.
 */
export const compressManageCandidates = (
    files: EnteFile[],
    includePreviouslyCompressed: boolean,
): EnteFile[] =>
    files.filter(
        (file) =>
            isCompressibleMediaType(file) &&
            (includePreviouslyCompressed || !isAlreadyCompressed(file)),
    );

/**
 * Merge source organizer tags and ensure the compressed tag is present.
 */
export const buildCompressedOrganizerTags = (sourceFile: EnteFile): string[] =>
    addTagNames(extractTags(sourceFile), COMPRESSED_TAG);

export const isAnimatedGifFile = (file: EnteFile): boolean => isGifFile(file);

/**
 * Derive the replacement title for a compressed file (basename, new extension).
 */
export const compressedReplaceTitle = (sourceFile: EnteFile): string => {
    const baseName = fileFileName(sourceFile).replace(/\.[^.]+$/u, "");
    if (sourceFile.metadata.fileType === FileType.video) {
        return `${baseName}.mp4`;
    }
    if (isGifFile(sourceFile)) {
        return `${baseName}.gif`;
    }
    return `${baseName}.jpg`;
};

const formatBytes = (bytes: number): string => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Format original vs compressed sizes and percent saved.
 */
export const formatSizeDelta = (
    originalBytes: number,
    compressedBytes: number,
): SizeDelta => {
    const savedBytes = Math.max(0, originalBytes - compressedBytes);
    const savedPercent =
        originalBytes > 0 ?
            Math.round((savedBytes / originalBytes) * 100) :
            0;
    return {
        originalBytes,
        compressedBytes,
        savedBytes,
        savedPercent,
        originalLabel: formatBytes(originalBytes),
        compressedLabel: formatBytes(compressedBytes),
        savedLabel: formatBytes(savedBytes),
    };
};

const encodeJpegMainThread = async (
    bytes: Uint8Array,
    quality: number,
): Promise<EncodeJpegResult> =>
    new Promise((resolve, reject) => {
        const blob = new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" });
        const imageUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = (): void => {
            URL.revokeObjectURL(imageUrl);
            try {
                const canvas = document.createElement("canvas");
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext("2d");
                if (!context) {
                    reject(new Error("Canvas unavailable"));
                    return;
                }
                context.drawImage(image, 0, 0);
                canvas.toBlob(
                    (jpegBlob) => {
                        if (!jpegBlob) {
                            reject(new Error("JPEG encode failed"));
                            return;
                        }
                        void jpegBlob.arrayBuffer().then((buffer) => {
                            resolve({
                                bytes: new Uint8Array(buffer),
                                width: image.width,
                                height: image.height,
                            });
                        });
                    },
                    "image/jpeg",
                    quality,
                );
            } catch (error: unknown) {
                reject(
                    error instanceof Error ?
                        error :
                        new Error("JPEG encode failed"),
                );
            }
        };
        image.onerror = (): void => {
            URL.revokeObjectURL(imageUrl);
            reject(new Error("Could not decode image"));
        };
        image.src = imageUrl;
    });

let worker: Worker | undefined;
let requestCounter = 0;

const getCompressWorker = (): Worker | undefined => {
    if (typeof Worker === "undefined") {
        return undefined;
    }
    if (!worker) {
        worker = new Worker(
            new URL("../workers/compress.worker.ts", import.meta.url),
        );
    }
    return worker;
};

export const terminateCompressWorker = (): void => {
    worker?.terminate();
    worker = undefined;
};

const encodeJpegInWorker = (
    bytes: Uint8Array,
    quality: number,
): Promise<EncodeJpegResult> =>
    new Promise((resolve, reject) => {
        const compressWorker = getCompressWorker();
        if (!compressWorker) {
            reject(new Error("Worker unavailable"));
            return;
        }

        const id = ++requestCounter;
        const onMessage = (event: MessageEvent<CompressWorkerResponse>): void => {
            if (event.data.id !== id) {
                return;
            }
            compressWorker.removeEventListener("message", onMessage);
            if (event.data.error) {
                reject(new Error(event.data.error));
                return;
            }
            if (!event.data.bytes || !event.data.width || !event.data.height) {
                reject(new Error("Encode returned incomplete result"));
                return;
            }
            resolve({
                bytes: event.data.bytes,
                width: event.data.width,
                height: event.data.height,
            });
        };

        compressWorker.addEventListener("message", onMessage);
        const request: CompressWorkerRequest = { id, bytes, quality };
        compressWorker.postMessage(request);
    });

/**
 * Re-encode image bytes as JPEG at the given quality (0–1).
 */
export const encodeJpegFromBytes = async (
    bytes: Uint8Array,
    quality: number,
): Promise<EncodeJpegResult> => {
    const clamped = Math.min(MAX_JPEG_QUALITY, Math.max(MIN_JPEG_QUALITY, quality));
    try {
        return await encodeJpegInWorker(bytes, clamped);
    } catch {
        return encodeJpegMainThread(bytes, clamped);
    }
};
