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

const HOME_INDICATOR_MAX_FRACTION = 0.12;
const HOME_INDICATOR_MAX_PX = 64;
const HOME_INDICATOR_MIN_AVG_LUMINANCE = 100;
const HOME_INDICATOR_MIN_WIDTH_FRACTION = 0.06;
const HOME_INDICATOR_MAX_WIDTH_FRACTION = 0.65;
const HOME_INDICATOR_CENTER_SLACK_FRACTION = 0.22;
/** Max fraction of the row that may be non-border for a home-indicator row. */
const HOME_INDICATOR_MAX_FILL_FRACTION = 0.65;

const pixelLuminance = (
    data: Uint8ClampedArray | Uint8Array,
    index: number,
): number =>
    0.299 * data[index]! + 0.587 * data[index + 1]! + 0.114 * data[index + 2]!;

const rowIsMostlyBorder = (
    data: Uint8ClampedArray | Uint8Array,
    width: number,
    row: number,
    left: number,
    right: number,
): boolean => {
    let samples = 0;
    let border = 0;
    for (let x = left; x <= right; x++) {
        const index = (row * width + x) * 4;
        samples++;
        if (
            isBorderPixel(
                data[index]!,
                data[index + 1]!,
                data[index + 2]!,
                data[index + 3]!,
            )
        ) {
            border++;
        }
    }
    return samples > 0 && border / samples >= 0.92;
};

/**
 * True when a full image row is a short centered bright/grey bar on an
 * otherwise empty backdrop. Tolerates downscale anti-aliasing.
 */
export const rowLooksLikeHomeIndicator = (
    data: Uint8ClampedArray | Uint8Array,
    width: number,
    row: number,
    _left?: number,
    _right?: number,
): boolean => {
    if (width < 16) {
        return false;
    }

    let spanMinX = width;
    let spanMaxX = -1;
    let nonBorder = 0;
    let luminanceSum = 0;

    for (let x = 0; x < width; x++) {
        const index = (row * width + x) * 4;
        const red = data[index]!;
        const green = data[index + 1]!;
        const blue = data[index + 2]!;
        const alpha = data[index + 3]!;
        if (isBorderPixel(red, green, blue, alpha)) {
            continue;
        }
        nonBorder++;
        luminanceSum += pixelLuminance(data, index);
        if (x < spanMinX) {
            spanMinX = x;
        }
        if (x > spanMaxX) {
            spanMaxX = x;
        }
    }

    if (spanMaxX < spanMinX || nonBorder < 3) {
        return false;
    }

    const span = spanMaxX - spanMinX + 1;
    const minSpan = Math.max(
        3,
        Math.round(width * HOME_INDICATOR_MIN_WIDTH_FRACTION),
    );
    const maxSpan = Math.round(width * HOME_INDICATOR_MAX_WIDTH_FRACTION);
    if (span < minSpan || span > maxSpan) {
        return false;
    }

    if (nonBorder / width > HOME_INDICATOR_MAX_FILL_FRACTION) {
        return false;
    }

    if (luminanceSum / nonBorder < HOME_INDICATOR_MIN_AVG_LUMINANCE) {
        return false;
    }

    const spanCenter = (spanMinX + spanMaxX) / 2;
    const imageCenter = (width - 1) / 2;
    const centerSlack = width * HOME_INDICATOR_CENTER_SLACK_FRACTION;
    return Math.abs(spanCenter - imageCenter) <= centerSlack;
};

/**
 * Find the top row of a phone home-indicator strip at the bottom of the image.
 * Returns the first row that should be excluded from content, or undefined.
 */
export const findBottomHomeIndicatorTop = (
    imageData: Pick<ImageData, "width" | "height" | "data">,
): number | undefined => {
    const { width, height, data } = imageData;
    if (width <= 0 || height <= 0) {
        return undefined;
    }

    const maxStrip = Math.min(
        HOME_INDICATOR_MAX_PX,
        Math.max(8, Math.floor(height * HOME_INDICATOR_MAX_FRACTION)),
    );

    let row = height - 1;
    while (row >= 0 && rowIsMostlyBorder(data, width, row, 0, width - 1)) {
        row--;
    }
    if (row < 0) {
        return undefined;
    }

    const indicatorBottom = row;
    if (!rowLooksLikeHomeIndicator(data, width, indicatorBottom)) {
        return undefined;
    }

    let indicatorTop = indicatorBottom;
    while (
        indicatorTop > 0 &&
        indicatorBottom - (indicatorTop - 1) + 1 <= maxStrip &&
        rowLooksLikeHomeIndicator(data, width, indicatorTop - 1)
    ) {
        indicatorTop--;
    }

    return indicatorTop;
};

/**
 * Clamp content bounds so they sit above a bottom home-indicator strip,
 * then trim any black letterbox that was trapped between the real content
 * and that indicator.
 */
export const trimBottomHomeIndicator = (
    imageData: Pick<ImageData, "width" | "height" | "data">,
    bounds: PixelRect,
): PixelRect => {
    const { width, data } = imageData;
    const indicatorTop = findBottomHomeIndicatorTop(imageData);
    let bottom = bounds.y + bounds.height - 1;
    if (indicatorTop !== undefined) {
        bottom = Math.min(bottom, indicatorTop - 1);
    }

    const left = bounds.x;
    const right = bounds.x + bounds.width - 1;
    // The white bar used to anchor the bbox bottom, so black letterbox between
    // the real image and the bar is still inside the rect — eat it upward.
    while (
        bottom > bounds.y &&
        rowIsMostlyBorder(data, width, bottom, left, right)
    ) {
        bottom--;
    }

    if (bottom >= bounds.y) {
        return {
            ...bounds,
            height: bottom - bounds.y + 1,
        };
    }

    if (indicatorTop !== undefined && indicatorTop > 0) {
        return {
            x: 0,
            y: 0,
            width: imageData.width,
            height: indicatorTop,
        };
    }
    return bounds;
};

/**
 * Find the bounding box of non-border pixels in raw RGBA image data.
 */
export const detectRawContentBoundsFromImageData = (
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

/**
 * Find content bounds, trimming phone screenshot home-indicator bars at the bottom.
 */
export const detectContentBoundsFromImageData = (
    imageData: Pick<ImageData, "width" | "height" | "data">,
    threshold = DEFAULT_CONTENT_THRESHOLD,
): PixelRect | undefined => {
    const raw = detectRawContentBoundsFromImageData(imageData, threshold);
    if (!raw) {
        const indicatorTop = findBottomHomeIndicatorTop(imageData);
        if (indicatorTop === undefined || indicatorTop <= 0) {
            return undefined;
        }
        return {
            x: 0,
            y: 0,
            width: imageData.width,
            height: indicatorTop,
        };
    }
    return trimBottomHomeIndicator(imageData, raw);
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
 * Detect content bounds from a drawable source using a downscaled sample plus
 * a higher-res bottom strip for home-indicator detection.
 */
const detectContentBoundsFromSource = (
    source: CanvasImageSource,
    naturalWidth: number,
    naturalHeight: number,
    threshold = DEFAULT_CONTENT_THRESHOLD,
    options?: {
        includeHomeIndicatorStrip?: boolean;
        maxEdge?: number;
        canvas?: HTMLCanvasElement;
    },
): PixelRect | undefined => {
    if (naturalWidth <= 0 || naturalHeight <= 0) {
        return undefined;
    }

    const maxEdge = options?.maxEdge ?? CONTENT_DETECT_MAX_EDGE;
    const includeHomeIndicatorStrip =
        options?.includeHomeIndicatorStrip !== false;
    const scale = Math.min(
        1,
        maxEdge / Math.max(naturalWidth, naturalHeight),
    );
    const detectWidth = Math.max(1, Math.round(naturalWidth * scale));
    const detectHeight = Math.max(1, Math.round(naturalHeight * scale));

    const canvas = options?.canvas ?? document.createElement("canvas");
    canvas.width = detectWidth;
    canvas.height = detectHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
        return undefined;
    }
    context.drawImage(source, 0, 0, detectWidth, detectHeight);
    const imageData = context.getImageData(0, 0, detectWidth, detectHeight);
    let detected = detectContentBoundsFromImageData(imageData, threshold);

    if (includeHomeIndicatorStrip) {
        const stripNaturalHeight = Math.min(
            naturalHeight,
            Math.max(
                32,
                Math.floor(naturalHeight * HOME_INDICATOR_MAX_FRACTION),
            ),
        );
        const stripScale = Math.min(1, 1080 / naturalWidth);
        const stripWidth = Math.max(1, Math.round(naturalWidth * stripScale));
        const stripHeight = Math.max(
            1,
            Math.round(stripNaturalHeight * stripScale),
        );
        const stripCanvas = document.createElement("canvas");
        stripCanvas.width = stripWidth;
        stripCanvas.height = stripHeight;
        const stripContext = stripCanvas.getContext("2d", {
            willReadFrequently: true,
        });
        if (stripContext) {
            stripContext.drawImage(
                source,
                0,
                naturalHeight - stripNaturalHeight,
                naturalWidth,
                stripNaturalHeight,
                0,
                0,
                stripWidth,
                stripHeight,
            );
            const stripData = stripContext.getImageData(
                0,
                0,
                stripWidth,
                stripHeight,
            );
            const stripIndicatorTop = findBottomHomeIndicatorTop(stripData);
            if (stripIndicatorTop !== undefined) {
                const indicatorNaturalY =
                    naturalHeight -
                    stripNaturalHeight +
                    Math.round(stripIndicatorTop / stripScale);
                const indicatorDetectY = Math.floor(indicatorNaturalY * scale);
                if (!detected) {
                    if (indicatorDetectY > 0) {
                        detected = {
                            x: 0,
                            y: 0,
                            width: detectWidth,
                            height: indicatorDetectY,
                        };
                    }
                } else {
                    const contentBottom = Math.min(
                        detected.y + detected.height - 1,
                        indicatorDetectY - 1,
                    );
                    if (contentBottom >= detected.y) {
                        detected = {
                            ...detected,
                            height: contentBottom - detected.y + 1,
                        };
                    } else if (indicatorDetectY > 0) {
                        detected = {
                            x: 0,
                            y: 0,
                            width: detectWidth,
                            height: indicatorDetectY,
                        };
                    }
                }
                if (detected) {
                    let bottom = detected.y + detected.height - 1;
                    const left = detected.x;
                    const right = detected.x + detected.width - 1;
                    while (
                        bottom > detected.y &&
                        rowIsMostlyBorder(
                            imageData.data,
                            detectWidth,
                            bottom,
                            left,
                            right,
                        )
                    ) {
                        bottom--;
                    }
                    if (bottom >= detected.y) {
                        detected = {
                            ...detected,
                            height: bottom - detected.y + 1,
                        };
                    }
                }
            }
        }
        stripCanvas.width = 0;
        stripCanvas.height = 0;
    }

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
 * Detect non-black content bounds for a loaded image element.
 */
export const detectContentBoundsFromElement = async (
    image: HTMLImageElement,
    threshold = DEFAULT_CONTENT_THRESHOLD,
): Promise<PixelRect | undefined> =>
    detectContentBoundsFromSource(
        image,
        image.naturalWidth,
        image.naturalHeight,
        threshold,
    );

/**
 * Detect content bounds from encoded image bytes without building a full-res
 * pixel buffer — used by mass auto-crop scanning.
 */
export const detectContentBoundsFromBytes = async (
    bytes: Uint8Array,
    mimeType: string,
    threshold = DEFAULT_CONTENT_THRESHOLD,
): Promise<
    { bounds: PixelRect; width: number; height: number } | undefined
> => {
    const bitmap = await createImageBitmap(
        new Blob([bytes], { type: mimeType }),
    );
    try {
        const bounds = detectContentBoundsFromSource(
            bitmap,
            bitmap.width,
            bitmap.height,
            threshold,
        );
        if (!bounds) {
            return undefined;
        }
        return {
            bounds,
            width: bitmap.width,
            height: bitmap.height,
        };
    } finally {
        bitmap.close();
    }
};

/** True when detected bounds trim more than a couple of pixels of border. */
export const hasMeaningfulBorder = (
    bounds: PixelRect,
    imageWidth: number,
    imageHeight: number,
): boolean => {
    const trimmed =
        bounds.x +
        bounds.y +
        (imageWidth - (bounds.x + bounds.width)) +
        (imageHeight - (bounds.y + bounds.height));
    // Ignore 1px rounding noise; require a real letterbox strip.
    return trimmed >= 8;
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
