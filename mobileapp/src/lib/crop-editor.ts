import type { Crop, PixelCrop } from "react-image-crop";
import {
    encodeCroppedJpeg,
    pixelCropToSourceRect,
    type CropRect,
} from "@/lib/crop";
import { rotateImageBytes, type RotationDegrees } from "@/lib/rotate";

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

export const cropRectForSave = (
    completedCrop: PixelCrop,
    image: Pick<
        HTMLImageElement,
        "width" | "height" | "naturalWidth" | "naturalHeight"
    >,
): CropRect => pixelCropToSourceRect(completedCrop, image);

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
