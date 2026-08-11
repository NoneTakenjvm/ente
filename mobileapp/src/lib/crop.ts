import { FileType } from "ente-media/file-type";
import { fileFileName } from "ente-media/file-metadata";
import type { EnteFile } from "ente-media/file";
import { extractTags } from "@/lib/tags";
import { addTagNames, removeTagNames } from "@/lib/tag-writes";
import { isGifFile } from "@/lib/media-kind";
import {
    DEFAULT_JPEG_QUALITY,
    MAX_JPEG_QUALITY,
    MIN_JPEG_QUALITY,
    type EncodeJpegResult,
} from "@/lib/compress";
import type {
    CompressWorkerRequest,
    CompressWorkerResponse,
    CropRect,
} from "@/workers/compress-worker-types";
import type { RotationDegrees } from "@/lib/rotate";

export type { CropRect };

export const CROPPED_TAG = "cropped";

/** Internal marker: auto-crop job has already considered this file. */
export const AUTO_CROPPED_TAG = "auto-cropped";

/**
 * Return true when the file is a croppable image.
 */
export const canCrop = (file: EnteFile): boolean =>
    file.metadata.fileType === FileType.image &&
    !isGifFile(file);

export const canCropVideo = (file: EnteFile): boolean =>
    file.metadata.fileType === FileType.video;

/**
 * Return true when auto-crop may still act on this file.
 */
export const canAutoCrop = (file: EnteFile): boolean =>
    canCrop(file) && !extractTags(file).includes(AUTO_CROPPED_TAG);

/**
 * Derive the upload title for a cropped copy of the source file.
 */
export const croppedUploadTitle = (sourceFile: EnteFile): string => {
    const baseName = fileFileName(sourceFile).replace(/\.[^.]+$/u, "");
    return `${baseName}-cropped.jpg`;
};

/**
 * Merge source organizer tags and ensure the cropped tag is present.
 *
 * Manual crop strips `auto-cropped` so the file matches the manual-crop filter
 * (and leaves "Not cropped"). Auto-crop keeps both markers.
 */
export const buildCroppedOrganizerTags = (
    sourceFile: EnteFile,
    options?: { autoCropped?: boolean },
): string[] => {
    let tags = addTagNames(extractTags(sourceFile), CROPPED_TAG);
    if (options?.autoCropped) {
        tags = addTagNames(tags, AUTO_CROPPED_TAG);
    } else {
        tags = removeTagNames(tags, AUTO_CROPPED_TAG);
    }
    return tags;
};

/**
 * Tags to mark a file as considered by auto-crop without changing pixels.
 */
export const buildAutoCropSkippedOrganizerTags = (
    sourceFile: EnteFile,
): string[] => addTagNames(extractTags(sourceFile), AUTO_CROPPED_TAG);

/**
 * Derive the replacement title for a cropped image (basename, .jpg).
 */
export const croppedReplaceTitle = (sourceFile: EnteFile): string => {
    const baseName = fileFileName(sourceFile).replace(/\.[^.]+$/u, "");
    return `${baseName}.jpg`;
};

export const croppedVideoUploadTitle = (title: string): string => {
    const baseName = title.replace(/\.[^.]+$/u, "");
    return `${baseName}-cropped.mp4`;
};

/**
 * Clamp a crop rectangle to image bounds.
 */
export const clampCropRect = (
    rect: CropRect,
    imageWidth: number,
    imageHeight: number,
): CropRect => {
    const width = Math.max(1, Math.min(Math.round(rect.width), imageWidth));
    const height = Math.max(1, Math.min(Math.round(rect.height), imageHeight));
    const x = Math.max(0, Math.min(Math.round(rect.x), imageWidth - width));
    const y = Math.max(0, Math.min(Math.round(rect.y), imageHeight - height));
    return { x, y, width, height };
};

/**
 * Map a pixel crop from displayed image dimensions to source image pixels.
 */
export const pixelCropToSourceRect = (
    pixelCrop: { x: number; y: number; width: number; height: number },
    image: Pick<HTMLImageElement, "width" | "height" | "naturalWidth" | "naturalHeight">,
): CropRect => {
    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    return {
        x: Math.round(pixelCrop.x * scaleX),
        y: Math.round(pixelCrop.y * scaleY),
        width: Math.round(pixelCrop.width * scaleX),
        height: Math.round(pixelCrop.height * scaleY),
    };
};

const rotationRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const boundingBoxForRotation = (
    width: number,
    height: number,
    degrees: number,
): { width: number; height: number } => {
    const radians = rotationRadians(degrees);
    return {
        width:
            Math.abs(Math.cos(radians) * width) +
            Math.abs(Math.sin(radians) * height),
        height:
            Math.abs(Math.sin(radians) * width) +
            Math.abs(Math.cos(radians) * height),
    };
};

const encodeCroppedJpegWithRotation = async (
    bytes: Uint8Array,
    cropRect: CropRect,
    rotationDegrees: RotationDegrees,
    quality: number,
): Promise<EncodeJpegResult> =>
    new Promise((resolve, reject) => {
        const blob = new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" });
        const imageUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = (): void => {
            URL.revokeObjectURL(imageUrl);
            try {
                const rotatedBox = boundingBoxForRotation(
                    image.width,
                    image.height,
                    rotationDegrees,
                );
                const rotateCanvas = document.createElement("canvas");
                rotateCanvas.width = Math.round(rotatedBox.width);
                rotateCanvas.height = Math.round(rotatedBox.height);
                const rotateContext = rotateCanvas.getContext("2d");
                if (!rotateContext) {
                    reject(new Error("Canvas unavailable"));
                    return;
                }
                rotateContext.translate(
                    rotateCanvas.width / 2,
                    rotateCanvas.height / 2,
                );
                rotateContext.rotate(rotationRadians(rotationDegrees));
                rotateContext.drawImage(
                    image,
                    -image.width / 2,
                    -image.height / 2,
                );
                const clamped = clampCropRect(
                    cropRect,
                    rotateCanvas.width,
                    rotateCanvas.height,
                );
                const outputCanvas = document.createElement("canvas");
                outputCanvas.width = clamped.width;
                outputCanvas.height = clamped.height;
                const outputContext = outputCanvas.getContext("2d");
                if (!outputContext) {
                    reject(new Error("Canvas unavailable"));
                    return;
                }
                outputContext.drawImage(
                    rotateCanvas,
                    clamped.x,
                    clamped.y,
                    clamped.width,
                    clamped.height,
                    0,
                    0,
                    clamped.width,
                    clamped.height,
                );
                outputCanvas.toBlob(
                    (jpegBlob) => {
                        if (!jpegBlob) {
                            reject(new Error("JPEG encode failed"));
                            return;
                        }
                        void jpegBlob.arrayBuffer().then((buffer) => {
                            resolve({
                                bytes: new Uint8Array(buffer),
                                width: clamped.width,
                                height: clamped.height,
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

const encodeCroppedJpegMainThread = async (
    bytes: Uint8Array,
    cropRect: CropRect,
    quality: number,
): Promise<EncodeJpegResult> =>
    new Promise((resolve, reject) => {
        const blob = new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" });
        const imageUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = (): void => {
            URL.revokeObjectURL(imageUrl);
            try {
                const clamped = clampCropRect(
                    cropRect,
                    image.width,
                    image.height,
                );
                const canvas = document.createElement("canvas");
                canvas.width = clamped.width;
                canvas.height = clamped.height;
                const context = canvas.getContext("2d");
                if (!context) {
                    reject(new Error("Canvas unavailable"));
                    return;
                }
                context.drawImage(
                    image,
                    clamped.x,
                    clamped.y,
                    clamped.width,
                    clamped.height,
                    0,
                    0,
                    clamped.width,
                    clamped.height,
                );
                canvas.toBlob(
                    (jpegBlob) => {
                        if (!jpegBlob) {
                            reject(new Error("JPEG encode failed"));
                            return;
                        }
                        void jpegBlob.arrayBuffer().then((buffer) => {
                            resolve({
                                bytes: new Uint8Array(buffer),
                                width: clamped.width,
                                height: clamped.height,
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

const encodeCroppedJpegInWorker = (
    bytes: Uint8Array,
    cropRect: CropRect,
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
            cropRect,
        };
        compressWorker.postMessage(request);
    });

/**
 * Crop image bytes to the given rectangle and encode as JPEG.
 */
export const encodeCroppedJpeg = async (
    bytes: Uint8Array,
    cropRect: CropRect,
    quality = DEFAULT_JPEG_QUALITY,
    rotationDegrees: RotationDegrees | 0 = 0,
): Promise<EncodeJpegResult> => {
    const clampedQuality = Math.min(
        MAX_JPEG_QUALITY,
        Math.max(MIN_JPEG_QUALITY, quality),
    );
    if (rotationDegrees !== 0) {
        return encodeCroppedJpegWithRotation(
            bytes,
            cropRect,
            rotationDegrees,
            clampedQuality,
        );
    }
    try {
        return await encodeCroppedJpegInWorker(
            bytes,
            cropRect,
            clampedQuality,
        );
    } catch {
        return encodeCroppedJpegMainThread(bytes, cropRect, clampedQuality);
    }
};
