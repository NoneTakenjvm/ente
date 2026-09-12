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
import { arrayBufferFromUint8Array } from "@/lib/bytes-blob";

export const COMPRESSED_TAG = "compressed";

export const DEFAULT_JPEG_QUALITY = 0.85;
export const DEFAULT_VIDEO_CRF = 28;
export const MIN_JPEG_QUALITY = 0.6;
export const MAX_JPEG_QUALITY = 0.95;
export const MIN_VIDEO_CRF = 18;
export const MAX_VIDEO_CRF = 32;

/** PhotoHoard skip floor; user-overridable via the Manage min-size menu. */
export const DEFAULT_MIN_SIZE_BYTES = 800 * 1024;
const COMPRESS_MIN_SIZE_KEY = "mobileapp-compress-min-size";

/** Minimum savings ratio (0–1) before replacing an original file. */
export const MIN_COMPRESSION_SAVINGS_RATIO = 0.02;

export class CompressionSkippedError extends Error {
    constructor(message = "Compression would not reduce file size") {
        super(message);
        this.name = "CompressionSkippedError";
    }
}

/** Compact byte label for overlays and selection chrome (e.g. `1.2 MB`). */
export const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export interface MinSizeFilterPreset {
    label: string;
    bytes: number;
}

export const MIN_SIZE_FILTER_PRESETS: MinSizeFilterPreset[] = [
    { label: "All sizes", bytes: 0 },
    { label: "500 KB+", bytes: 512_000 },
    { label: "800 KB+", bytes: DEFAULT_MIN_SIZE_BYTES },
    { label: "1 MB+", bytes: 1_024_000 },
    { label: "2 MB+", bytes: 2_048_000 },
    { label: "5 MB+", bytes: 5_242_880 },
    { label: "10 MB+", bytes: 10_485_760 },
];

/**
 * Read the persisted min-size skip floor (defaults to 800 KB).
 */
export const readCompressMinSizeBytes = (): number => {
    if (typeof window === "undefined") {
        return DEFAULT_MIN_SIZE_BYTES;
    }
    try {
        const raw = localStorage.getItem(COMPRESS_MIN_SIZE_KEY);
        if (raw === null) {
            return DEFAULT_MIN_SIZE_BYTES;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) {
            return DEFAULT_MIN_SIZE_BYTES;
        }
        return parsed;
    } catch {
        return DEFAULT_MIN_SIZE_BYTES;
    }
};

/**
 * Persist the min-size skip floor for Manage and the viewer.
 */
export const writeCompressMinSizeBytes = (bytes: number): void => {
    if (typeof window === "undefined") {
        return;
    }
    try {
        localStorage.setItem(COMPRESS_MIN_SIZE_KEY, String(bytes));
    } catch {
        // Ignore quota errors.
    }
};

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
    "avif" |
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
                subtype.startsWith("avif") ||
                subtype.startsWith("avis")
            ) {
                return "avif";
            }
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

/**
 * Merge source organizer tags and ensure the compressed tag is present.
 */
export const buildCompressedOrganizerTags = (sourceFile: EnteFile): string[] =>
    addTagNames(extractTags(sourceFile), COMPRESSED_TAG);

export const isAnimatedGifFile = (file: EnteFile): boolean => isGifFile(file);

/**
 * Derive the replacement title for a compressed file (basename, new extension).
 */
export const compressedReplaceTitle = (
    sourceFile: EnteFile,
    extension?: string,
): string => {
    const baseName = fileFileName(sourceFile).replace(/\.[^.]+$/u, "");
    if (extension) {
        return `${baseName}.${extension.replace(/^\./u, "")}`;
    }
    if (sourceFile.metadata.fileType === FileType.video) {
        return `${baseName}.mp4`;
    }
    if (isGifFile(sourceFile)) {
        return `${baseName}.gif`;
    }
    return `${baseName}.avif`;
};

const formatBytes = formatFileSize;

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

const copiedBuffer = (bytes: Uint8Array): ArrayBuffer =>
    arrayBufferFromUint8Array(bytes);

const postCompressRequest = (
    request: CompressWorkerRequest,
    transfer: Transferable[],
): Promise<CompressWorkerResponse> =>
    new Promise((resolve, reject) => {
        const compressWorker = getCompressWorker();
        if (!compressWorker) {
            reject(new Error("Worker unavailable"));
            return;
        }

        const onMessage = (event: MessageEvent<CompressWorkerResponse>): void => {
            if (event.data.id !== request.id) {
                return;
            }
            compressWorker.removeEventListener("message", onMessage);
            resolve(event.data);
        };

        compressWorker.addEventListener("message", onMessage);
        compressWorker.postMessage(request, transfer);
    });

const encodeJpegInWorker = async (
    bytes: Uint8Array,
    quality: number,
): Promise<EncodeJpegResult> => {
    const buffer = copiedBuffer(bytes);
    const response = await postCompressRequest(
        {
            id: ++requestCounter,
            bytes: new Uint8Array(buffer),
            quality,
            preferSmaller: true,
            output: "jpeg",
        },
        [buffer],
    );
    if (response.error) {
        throw new Error(response.error);
    }
    if (!response.bytes || !response.width || !response.height) {
        throw new Error("Encode returned incomplete result");
    }
    return {
        bytes: response.bytes,
        width: response.width,
        height: response.height,
    };
};

export interface EncodeStillImageResult {
    bytes: Uint8Array;
    width: number;
    height: number;
    mimeType: string;
    extension: string;
}

const encodeStillInWorker = async (
    bytes: Uint8Array,
    minSizeBytes: number,
): Promise<EncodeStillImageResult> => {
    const buffer = copiedBuffer(bytes);
    const response = await postCompressRequest(
        {
            id: ++requestCounter,
            bytes: new Uint8Array(buffer),
            quality: DEFAULT_JPEG_QUALITY,
            output: "auto",
            minSizeBytes,
        },
        [buffer],
    );
    if (response.skipped) {
        throw new CompressionSkippedError();
    }
    if (response.error) {
        throw new Error(response.error);
    }
    if (
        !response.bytes ||
        !response.width ||
        !response.height ||
        !response.mimeType ||
        !response.extension
    ) {
        throw new Error("Encode returned incomplete result");
    }
    return {
        bytes: response.bytes,
        width: response.width,
        height: response.height,
        mimeType: response.mimeType,
        extension: response.extension,
    };
};

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

/**
 * Classify and compress a still image with PhotoHoard AVIF/WebP presets.
 */
export const encodeCompressedStillFromBytes = async (
    bytes: Uint8Array,
    minSizeBytes: number,
): Promise<EncodeStillImageResult> => {
    if (minSizeBytes > 0 && bytes.length < minSizeBytes) {
        throw new CompressionSkippedError();
    }
    return encodeStillInWorker(bytes, minSizeBytes);
};
