import { FileType } from "ente-media/file-type";
import { fileFileName } from "ente-media/file-metadata";
import type { EnteFile } from "ente-media/file";
import { extractTags } from "@/lib/tags";
import { addTagNames } from "@/lib/tag-writes";
import { isGifFile } from "@/lib/media-kind";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import type {
    CompressWorkerRequest,
    CompressWorkerResponse,
} from "@/workers/compress-worker-types";

export const COMPRESSED_TAG = "compressed";

export const DEFAULT_JPEG_QUALITY = 0.85;
export const DEFAULT_VIDEO_CRF = 28;
export const MIN_JPEG_QUALITY = 0.6;
export const MAX_JPEG_QUALITY = 0.95;
export const MIN_VIDEO_CRF = 18;
export const MAX_VIDEO_CRF = 32;

/** Minimum savings ratio (0–1) before replacing an original file. */
export const MIN_COMPRESSION_SAVINGS_RATIO = 0.02;

export class CompressionSkippedError extends Error {
    constructor(message = "Compression would not reduce file size") {
        super(message);
        this.name = "CompressionSkippedError";
    }
}

export interface MinSizeFilterPreset {
    label: string;
    bytes: number;
}

export const MIN_SIZE_FILTER_PRESETS: MinSizeFilterPreset[] = [
    { label: "All sizes", bytes: 0 },
    { label: "500 KB+", bytes: 512_000 },
    { label: "1 MB+", bytes: 1_024_000 },
    { label: "2 MB+", bytes: 2_048_000 },
    { label: "5 MB+", bytes: 5_242_880 },
    { label: "10 MB+", bytes: 10_485_760 },
];

export interface EncodeJpegResult {
    bytes: Uint8Array;
    width: number;
    height: number;
}

export type DetectedImageFormat =
    | "jpeg" |
    "png" |
    "webp" |
    "gif" |
    "heic" |
    "unknown";

/**
 * Detect container format from magic bytes (for encode strategy and diagnostics).
 */
export const detectImageFormatFromBytes = (
    bytes: Uint8Array,
): DetectedImageFormat => {
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return "jpeg";
    }
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
    ) {
        return "png";
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return "webp";
    }
    if (
        bytes.length >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46
    ) {
        return "gif";
    }
    if (bytes.length >= 12) {
        const brand = String.fromCharCode(
            bytes[4] ?? 0,
            bytes[5] ?? 0,
            bytes[6] ?? 0,
            bytes[7] ?? 0,
        );
        if (brand === "ftyp") {
            const subtype = String.fromCharCode(
                bytes[8] ?? 0,
                bytes[9] ?? 0,
                bytes[10] ?? 0,
                bytes[11] ?? 0,
            );
            if (
                subtype.startsWith("heic") ||
                subtype.startsWith("heix") ||
                subtype.startsWith("mif1")
            ) {
                return "heic";
            }
        }
    }
    return "unknown";
};

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
 * Archived files are skipped (long-term storage).
 */
export const compressManageCandidates = (
    files: EnteFile[],
    includePreviouslyCompressed: boolean,
): EnteFile[] =>
    files.filter(
        (file) =>
            !isFileArchivedLocally(file) &&
            isCompressibleMediaType(file) &&
            (includePreviouslyCompressed || !isAlreadyCompressed(file)),
    );

/**
 * Read encrypted file size from sync metadata (0 when unknown).
 */
export const fileByteSize = (file: EnteFile): number => file.info?.fileSize ?? 0;

/**
 * Keep only files at or above the minimum byte size.
 */
export const filterCompressCandidatesByMinSize = (
    files: EnteFile[],
    minBytes: number,
): EnteFile[] => {
    if (minBytes <= 0) {
        return files;
    }
    return files.filter((file) => fileByteSize(file) >= minBytes);
};

/**
 * Sort compress candidates largest-first for the manage tab.
 */
export const sortCompressCandidatesBySize = (files: EnteFile[]): EnteFile[] =>
    [...files].sort((a, b) => fileByteSize(b) - fileByteSize(a));

/**
 * Return true when compressed bytes are smaller than the original by at least
 * {@link MIN_COMPRESSION_SAVINGS_RATIO}.
 */
export const isWorthReplacing = (
    originalBytes: number,
    compressedBytes: number,
): boolean => {
    if (originalBytes <= 0) {
        return compressedBytes > 0;
    }
    const minBytes = originalBytes * (1 - MIN_COMPRESSION_SAVINGS_RATIO);
    return compressedBytes < minBytes;
};

export type MarqueeDragIntent = "pending" | "scroll" | "marquee";

/**
 * Resolve pointer drag intent for mass-selection vs vertical scroll.
 * Marquee requires a horizontal-first gesture (Apple Photos pattern).
 */
export const resolveMarqueeDragIntent = (
    dx: number,
    dy: number,
    thresholdPx: number,
): MarqueeDragIntent | null => {
    if (Math.abs(dx) < thresholdPx && Math.abs(dy) < thresholdPx) {
        return "pending";
    }
    if (Math.abs(dx) >= thresholdPx && Math.abs(dx) > Math.abs(dy)) {
        return "marquee";
    }
    if (Math.abs(dy) >= thresholdPx && Math.abs(dy) >= Math.abs(dx)) {
        return "scroll";
    }
    return null;
};

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
        const request: CompressWorkerRequest = {
            id,
            bytes,
            quality,
            preferSmaller: true,
        };
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
