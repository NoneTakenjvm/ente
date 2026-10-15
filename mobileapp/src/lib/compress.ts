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
import {
    arrayBufferFromUint8Array,
    blobFromUint8Array,
} from "@/lib/bytes-blob";
import { formatFileSize } from "@/lib/format";
import { createWorkerClient } from "@/lib/worker-client";

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
const MIN_COMPRESSION_SAVINGS_RATIO = 0.02;

export class CompressionSkippedError extends Error {
    constructor(message = "Compression would not reduce file size") {
        super(message);
        this.name = "CompressionSkippedError";
    }
}

/** A worker encode exceeded its time limit; the worker was discarded. */
export class CompressWorkerTimeoutError extends Error {
    constructor(message = "Image encode timed out") {
        super(message);
        this.name = "CompressWorkerTimeoutError";
    }
}

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
        originalLabel: formatFileSize(originalBytes),
        compressedLabel: formatFileSize(compressedBytes),
        savedLabel: formatFileSize(savedBytes),
    };
};

/**
 * Decode image bytes with the browser's own decoder (main-thread fallback
 * paths). Rejects when the bytes cannot be decoded.
 */
export const decodeImageElement = (
    bytes: Uint8Array,
): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const imageUrl = URL.createObjectURL(
            blobFromUint8Array(bytes, "image/jpeg"),
        );
        const image = new Image();
        image.onload = (): void => {
            URL.revokeObjectURL(imageUrl);
            resolve(image);
        };
        image.onerror = (): void => {
            URL.revokeObjectURL(imageUrl);
            reject(new Error("Could not decode image"));
        };
        image.src = imageUrl;
    });

/** A 2D canvas of the given size, throwing when the context is unavailable. */
export const createCanvas2d = (
    width: number,
    height: number,
): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("Canvas unavailable");
    }
    return { canvas, context };
};

/** Encode a canvas as JPEG bytes at {@link quality} (0–1). */
export const encodeCanvasJpeg = (
    canvas: HTMLCanvasElement,
    quality: number,
): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
        canvas.toBlob(
            (jpegBlob) => {
                if (!jpegBlob) {
                    reject(new Error("JPEG encode failed"));
                    return;
                }
                jpegBlob
                    .arrayBuffer()
                    .then((buffer) => {
                        resolve(new Uint8Array(buffer));
                    })
                    .catch(reject);
            },
            "image/jpeg",
            quality,
        );
    });

const encodeJpegMainThread = async (
    bytes: Uint8Array,
    quality: number,
): Promise<EncodeJpegResult> => {
    const image = await decodeImageElement(bytes);
    const { canvas, context } = createCanvas2d(image.width, image.height);
    context.drawImage(image, 0, 0);
    return {
        bytes: await encodeCanvasJpeg(canvas, quality),
        width: image.width,
        height: image.height,
    };
};

/** Release the compress worker's WASM encoders after this long with no requests. */
const COMPRESS_WORKER_IDLE_TERMINATE_MS = 30_000;

/**
 * A stuck encode would block later requests on the worker, so a timeout drops
 * the whole worker and every pending request fails with it.
 */
const COMPRESS_WORKER_TIMEOUT_MS = 45_000;

const compressWorker = createWorkerClient<
    CompressWorkerRequest,
    CompressWorkerResponse
>({
    createWorker: () =>
        new Worker(new URL("../workers/compress.worker.ts", import.meta.url)),
    idleMs: COMPRESS_WORKER_IDLE_TERMINATE_MS,
    timeoutMs: COMPRESS_WORKER_TIMEOUT_MS,
    timeoutError: () => new CompressWorkerTimeoutError(),
});

/**
 * Encode JPEG bytes in the compress worker. {@link options} carries the quality
 * plus the crop rectangle or size preference for this request.
 */
export const encodeJpegInWorker = async (
    bytes: Uint8Array,
    options: Pick<
        CompressWorkerRequest,
        "quality" | "cropRect" | "normalizedCropRect" | "preferSmaller"
    >,
): Promise<EncodeJpegResult> => {
    const buffer = arrayBufferFromUint8Array(bytes);
    const response = await compressWorker.request(
        {
            bytes: new Uint8Array(buffer),
            ...options,
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

/**
 * Crop an image to its detected black border in the compress worker, with a
 * single decode off the main thread.
 *
 * @returns the cropped JPEG, or `undefined` when there is no meaningful border
 */
export const autoCropJpegInWorker = async (
    bytes: Uint8Array,
): Promise<EncodeJpegResult | undefined> => {
    const buffer = arrayBufferFromUint8Array(bytes);
    const response = await compressWorker.request(
        {
            bytes: new Uint8Array(buffer),
            quality: DEFAULT_JPEG_QUALITY,
            autoCrop: true,
        },
        [buffer],
    );
    if (response.error) {
        throw new Error(response.error);
    }
    if (response.skipped) {
        return undefined;
    }
    if (!response.bytes || !response.width || !response.height) {
        throw new Error("Auto-crop returned incomplete result");
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
    const buffer = arrayBufferFromUint8Array(bytes);
    const response = await compressWorker.request(
        {
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
        return await encodeJpegInWorker(bytes, {
            quality: clamped,
            preferSmaller: true,
        });
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
