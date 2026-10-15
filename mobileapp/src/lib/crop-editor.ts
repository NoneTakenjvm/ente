import { clampCropRect, type CropRect } from "@/lib/crop";
import { normalizedToPixelRect, type NormalizedCropRect } from "@/lib/crop-draft";

/** Normalized crops within this of the full frame count as uncropped. */
const CROP_EPSILON = 1e-4;

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

/** Source-pixel crop for a video edit, clamped to the frame. */
export const cropRectForVideoSave = (
    crop: NormalizedCropRect,
    sourceWidth: number,
    sourceHeight: number,
): CropRect =>
    clampCropRect(
        normalizedToPixelRect(crop, sourceWidth, sourceHeight),
        sourceWidth,
        sourceHeight,
    );

/** True when the crop is smaller than the whole frame. */
export const videoCropChanged = (crop: NormalizedCropRect): boolean =>
    crop.x > CROP_EPSILON ||
    crop.y > CROP_EPSILON ||
    crop.width < 1 - CROP_EPSILON ||
    crop.height < 1 - CROP_EPSILON;

export const trimRangeChanged = (
    trim: { startSec: number; endSec: number },
    durationSec: number,
): boolean =>
    durationSec > 0 &&
    (trim.startSec > 0.05 || trim.endSec < durationSec - 0.05);
