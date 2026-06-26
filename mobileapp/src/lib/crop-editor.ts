import type { Crop, PixelCrop } from "react-image-crop";
import {
    encodeCroppedJpeg,
    pixelCropToSourceRect,
    type CropRect,
} from "@/lib/crop";
import { rotateImageBytes, type RotationDegrees } from "@/lib/rotate";

export interface PixelRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

const CONTENT_DETECT_MAX_EDGE = 512;
const DEFAULT_CONTENT_THRESHOLD = 12;
const DEFAULT_ALPHA_THRESHOLD = 8;

export const fullImageCrop = (width: number, height: number): Crop => ({
    unit: "px",
    x: 0,
    y: 0,
    width,
    height,
});

export const fullFramePixelCrop = (
    displayWidth: number,
    displayHeight: number,
): PixelCrop => ({
    unit: "px",
    x: 0,
    y: 0,
    width: displayWidth,
    height: displayHeight,
});

/** Fit natural pixels into a max box (object-contain) for the crop UI. */
export const containedDisplaySize = (
    naturalWidth: number,
    naturalHeight: number,
    maxWidth: number,
    maxHeight: number,
): { width: number; height: number } => {
    if (
        naturalWidth <= 0 ||
        naturalHeight <= 0 ||
        maxWidth <= 0 ||
        maxHeight <= 0
    ) {
        return { width: 0, height: 0 };
    }
    const scale = Math.min(
        maxWidth / naturalWidth,
        maxHeight / naturalHeight,
        1,
    );
    return {
        width: Math.max(1, Math.round(naturalWidth * scale)),
        height: Math.max(1, Math.round(naturalHeight * scale)),
    };
};

/**
 * Return true when a pixel looks like empty border (black or transparent).
 */
export const isBorderPixel = (
    red: number,
    green: number,
    blue: number,
    alpha: number,
    threshold = DEFAULT_CONTENT_THRESHOLD,
    alphaThreshold = DEFAULT_ALPHA_THRESHOLD,
): boolean => {
    if (alpha <= alphaThreshold) {
        return true;
    }
    return red <= threshold && green <= threshold && blue <= threshold;
};

/**
 * Find the bounding box of non-border pixels in raw RGBA image data.
 */
export const detectContentBoundsFromImageData = (
    imageData: Pick<ImageData, "width" | "height" | "data">,
    threshold = DEFAULT_CONTENT_THRESHOLD,
): PixelRect | undefined => {
    const { width, height, data } = imageData;
    if (width <= 0 || height <= 0) {
        return undefined;
    }

    const isContentAt = (x: number, y: number): boolean => {
        const index = (y * width + x) * 4;
        return !isBorderPixel(
            data[index]!,
            data[index + 1]!,
            data[index + 2]!,
            data[index + 3]!,
            threshold,
        );
    };

    let top = 0;
    topScan: for (; top < height; top++) {
        for (let x = 0; x < width; x++) {
            if (isContentAt(x, top)) {
                break topScan;
            }
        }
    }
    if (top >= height) {
        return undefined;
    }

    let bottom = height - 1;
    bottomScan: for (; bottom > top; bottom--) {
        for (let x = 0; x < width; x++) {
            if (isContentAt(x, bottom)) {
                break bottomScan;
            }
        }
    }

    let left = 0;
    leftScan: for (; left < width; left++) {
        for (let y = top; y <= bottom; y++) {
            if (isContentAt(left, y)) {
                break leftScan;
            }
        }
    }

    let right = width - 1;
    rightScan: for (; right > left; right--) {
        for (let y = top; y <= bottom; y++) {
            if (isContentAt(right, y)) {
                break rightScan;
            }
        }
    }

    return {
        x: left,
        y: top,
        width: right - left + 1,
        height: bottom - top + 1,
    };
};

const mapDetectedBoundsToNatural = (
    detected: PixelRect,
    naturalWidth: number,
    naturalHeight: number,
    scale: number,
): PixelRect => {
    const invScale = 1 / scale;
    const x = Math.min(naturalWidth - 1, Math.round(detected.x * invScale));
    const y = Math.min(naturalHeight - 1, Math.round(detected.y * invScale));
    const width = Math.min(
        naturalWidth - x,
        Math.max(1, Math.round(detected.width * invScale)),
    );
    const height = Math.min(
        naturalHeight - y,
        Math.max(1, Math.round(detected.height * invScale)),
    );
    return { x, y, width, height };
};

/**
 * Detect non-black content bounds for a loaded image element.
 */
export const detectContentBoundsFromElement = async (
    image: HTMLImageElement,
    threshold = DEFAULT_CONTENT_THRESHOLD,
): Promise<PixelRect | undefined> => {
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    if (naturalWidth <= 0 || naturalHeight <= 0) {
        return undefined;
    }

    const scale = Math.min(
        1,
        CONTENT_DETECT_MAX_EDGE / Math.max(naturalWidth, naturalHeight),
    );
    const detectWidth = Math.max(1, Math.round(naturalWidth * scale));
    const detectHeight = Math.max(1, Math.round(naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = detectWidth;
    canvas.height = detectHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
        return undefined;
    }
    context.drawImage(image, 0, 0, detectWidth, detectHeight);
    const imageData = context.getImageData(0, 0, detectWidth, detectHeight);
    const detected = detectContentBoundsFromImageData(imageData, threshold);
    if (!detected) {
        return undefined;
    }

    const bounds = mapDetectedBoundsToNatural(
        detected,
        naturalWidth,
        naturalHeight,
        scale,
    );
    if (
        bounds.x === 0 &&
        bounds.y === 0 &&
        bounds.width === naturalWidth &&
        bounds.height === naturalHeight
    ) {
        return undefined;
    }
    return bounds;
};

/**
 * Initial crop rectangle in display space, trimmed to visible content when
 * the source image has black or transparent borders.
 */
export const initialCropForDisplay = (
    displayWidth: number,
    displayHeight: number,
    naturalWidth: number,
    naturalHeight: number,
    contentBounds?: PixelRect,
): Crop => {
    if (
        !contentBounds ||
        (contentBounds.x === 0 &&
            contentBounds.y === 0 &&
            contentBounds.width === naturalWidth &&
            contentBounds.height === naturalHeight)
    ) {
        return fullImageCrop(displayWidth, displayHeight);
    }
    const scaleX = displayWidth / naturalWidth;
    const scaleY = displayHeight / naturalHeight;
    const x = Math.round(contentBounds.x * scaleX);
    const y = Math.round(contentBounds.y * scaleY);
    const width = Math.max(1, Math.round(contentBounds.width * scaleX));
    const height = Math.max(1, Math.round(contentBounds.height * scaleY));
    return {
        unit: "px",
        x,
        y,
        width: Math.min(width, displayWidth - x),
        height: Math.min(height, displayHeight - y),
    };
};

export const cropRectForSave = (
    completedCrop: PixelCrop,
    image: Pick<
        HTMLImageElement,
        "width" | "height" | "naturalWidth" | "naturalHeight"
    >,
): CropRect => pixelCropToSourceRect(completedCrop, image);

export const cropRectForVideoSave = (
    completedCrop: PixelCrop,
    video: Pick<
        HTMLVideoElement,
        "width" | "height" | "videoWidth" | "videoHeight"
    >,
): CropRect =>
    pixelCropToSourceRect(completedCrop, {
        width: video.width,
        height: video.height,
        naturalWidth: video.videoWidth,
        naturalHeight: video.videoHeight,
    });

/**
 * Detect non-black content bounds from the current video frame.
 */
export const detectContentBoundsFromVideo = async (
    video: HTMLVideoElement,
    threshold = DEFAULT_CONTENT_THRESHOLD,
): Promise<PixelRect | undefined> => {
    const naturalWidth = video.videoWidth;
    const naturalHeight = video.videoHeight;
    if (naturalWidth <= 0 || naturalHeight <= 0) {
        return undefined;
    }

    const scale = Math.min(
        1,
        CONTENT_DETECT_MAX_EDGE / Math.max(naturalWidth, naturalHeight),
    );
    const detectWidth = Math.max(1, Math.round(naturalWidth * scale));
    const detectHeight = Math.max(1, Math.round(naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = detectWidth;
    canvas.height = detectHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
        return undefined;
    }
    context.drawImage(video, 0, 0, detectWidth, detectHeight);
    const imageData = context.getImageData(0, 0, detectWidth, detectHeight);
    const detected = detectContentBoundsFromImageData(imageData, threshold);
    if (!detected) {
        return undefined;
    }

    const bounds = mapDetectedBoundsToNatural(
        detected,
        naturalWidth,
        naturalHeight,
        scale,
    );
    if (
        bounds.x === 0 &&
        bounds.y === 0 &&
        bounds.width === naturalWidth &&
        bounds.height === naturalHeight
    ) {
        return undefined;
    }
    return bounds;
};

/** Canvas size after a 90° or 270° baked rotation. */
export const dimensionsAfterQuarterTurn = (
    width: number,
    height: number,
): { width: number; height: number } => ({
    width: height,
    height: width,
});

export const dimensionsAfterRotation = (
    width: number,
    height: number,
    degrees: RotationDegrees,
): { width: number; height: number } => {
    if (degrees === 90 || degrees === 270) {
        return dimensionsAfterQuarterTurn(width, height);
    }
    return { width, height };
};

/**
 * Bake rotation into working bytes (WYSIWYG editor path — no CSS transform).
 */
export const bakeRotation = (
    bytes: Uint8Array,
    mimeType: string,
    degrees: RotationDegrees,
): ReturnType<typeof rotateImageBytes> =>
    rotateImageBytes(bytes, mimeType, degrees);

/**
 * Encode a crop from baked working bytes using display-space crop coordinates.
 */
export const encodeBakedCrop = (
    workingBytes: Uint8Array,
    completedCrop: PixelCrop,
    image: Pick<
        HTMLImageElement,
        "width" | "height" | "naturalWidth" | "naturalHeight"
    >,
): ReturnType<typeof encodeCroppedJpeg> => {
    const cropRect = cropRectForSave(completedCrop, image);
    return encodeCroppedJpeg(workingBytes, cropRect);
};

export const videoCropChanged = (
    completedCrop: PixelCrop,
    displayWidth: number,
    displayHeight: number,
): boolean =>
    completedCrop.x > 0 ||
    completedCrop.y > 0 ||
    completedCrop.width < displayWidth ||
    completedCrop.height < displayHeight;

export const trimRangeChanged = (
    trim: { startSec: number; endSec: number },
    durationSec: number,
): boolean =>
    durationSec > 0 &&
    (trim.startSec > 0.05 || trim.endSec < durationSec - 0.05);
