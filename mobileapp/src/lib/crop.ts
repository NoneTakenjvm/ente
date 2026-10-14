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
    CompressWorkerTimeoutError,
    createCanvas2d,
    decodeImageElement,
    encodeCanvasJpeg,
    encodeJpegInWorker,
    type EncodeJpegResult,
} from "@/lib/compress";
import { normalizedToPixelRect, type NormalizedCropRect } from "@/lib/crop-draft";
import type { CropRect } from "@/workers/compress-worker-types";
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
 * Derive the replacement title for a cropped image (basename, .jpg).
 */
export const croppedReplaceTitle = (sourceFile: EnteFile): string => {
    const baseName = fileFileName(sourceFile).replace(/\.[^.]+$/u, "");
    return `${baseName}.jpg`;
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

/** Crop {@link source} to {@link cropRect} (clamped to its size) and encode as JPEG. */
const encodeCroppedCanvasJpeg = async (
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    cropRect: CropRect,
    quality: number,
): Promise<EncodeJpegResult> => {
    const clamped = clampCropRect(cropRect, sourceWidth, sourceHeight);
    const { canvas, context } = createCanvas2d(clamped.width, clamped.height);
    context.drawImage(
        source,
        clamped.x,
        clamped.y,
        clamped.width,
        clamped.height,
        0,
        0,
        clamped.width,
        clamped.height,
    );
    return {
        bytes: await encodeCanvasJpeg(canvas, quality),
        width: clamped.width,
        height: clamped.height,
    };
};

const encodeCroppedJpegWithRotation = async (
    bytes: Uint8Array,
    cropRect: CropRect,
    rotationDegrees: RotationDegrees,
    quality: number,
): Promise<EncodeJpegResult> => {
    const image = await decodeImageElement(bytes);
    const rotatedBox = boundingBoxForRotation(
        image.width,
        image.height,
        rotationDegrees,
    );
    const { canvas, context } = createCanvas2d(
        Math.round(rotatedBox.width),
        Math.round(rotatedBox.height),
    );
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(rotationRadians(rotationDegrees));
    context.drawImage(image, -image.width / 2, -image.height / 2);
    return encodeCroppedCanvasJpeg(
        canvas,
        canvas.width,
        canvas.height,
        cropRect,
        quality,
    );
};

const clampJpegQuality = (quality: number): number =>
    Math.min(MAX_JPEG_QUALITY, Math.max(MIN_JPEG_QUALITY, quality));

/**
 * Crop image bytes to the given rectangle and encode as JPEG.
 */
export const encodeCroppedJpeg = async (
    bytes: Uint8Array,
    cropRect: CropRect,
    quality = DEFAULT_JPEG_QUALITY,
    rotationDegrees: RotationDegrees | 0 = 0,
): Promise<EncodeJpegResult> => {
    const clampedQuality = clampJpegQuality(quality);
    if (rotationDegrees !== 0) {
        return encodeCroppedJpegWithRotation(
            bytes,
            cropRect,
            rotationDegrees,
            clampedQuality,
        );
    }
    try {
        return await encodeJpegInWorker(bytes, {
            quality: clampedQuality,
            cropRect,
        });
    } catch (error: unknown) {
        // A timed-out worker is a stuck encode; retrying it on the main thread
        // would stall the UI for the same work.
        if (error instanceof CompressWorkerTimeoutError) {
            throw error;
        }
        const image = await decodeImageElement(bytes);
        return encodeCroppedCanvasJpeg(
            image,
            image.width,
            image.height,
            cropRect,
            clampedQuality,
        );
    }
};

/**
 * Like {@link encodeCroppedJpeg}, but the rectangle is in 0-1 units of the
 * image, so the caller needs no decode of its own to learn the image size.
 */
export const encodeNormalizedCroppedJpeg = async (
    bytes: Uint8Array,
    normalizedCropRect: NormalizedCropRect,
    quality = DEFAULT_JPEG_QUALITY,
): Promise<EncodeJpegResult> => {
    const clampedQuality = clampJpegQuality(quality);
    try {
        return await encodeJpegInWorker(bytes, {
            quality: clampedQuality,
            normalizedCropRect,
        });
    } catch (error: unknown) {
        if (error instanceof CompressWorkerTimeoutError) {
            throw error;
        }
        const image = await decodeImageElement(bytes);
        return encodeCroppedCanvasJpeg(
            image,
            image.width,
            image.height,
            normalizedToPixelRect(normalizedCropRect, image.width, image.height),
            clampedQuality,
        );
    }
};
