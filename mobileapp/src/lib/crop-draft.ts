import type { CropRect } from "@/lib/crop";

/** Crop rectangle in 0–1 units relative to the image. */
export interface NormalizedCropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Draft quick-crop for one file; `imageAspect` is width / height of the image. */
export interface PendingCrop {
    rect: NormalizedCropRect;
    imageAspect: number;
}

/** Which part of the crop box a drag grabbed: the body or one corner. */
export type CropDragHandle = "move" | "nw" | "ne" | "sw" | "se";

/** Where the image sits inside a tile, in tile pixels. */
export interface ContainedBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * Largest centered crop of `targetAspect` that fits the image, as the
 * normalized form of `maxAspectRatioCrop`. Falls back to the whole image.
 */
export const defaultNormalizedCrop = (
    imageAspect: number,
    targetAspect: number,
): NormalizedCropRect => {
    if (imageAspect <= 0 || targetAspect <= 0) {
        return { x: 0, y: 0, width: 1, height: 1 };
    }
    if (imageAspect > targetAspect) {
        const width = targetAspect / imageAspect;
        return { x: (1 - width) / 2, y: 0, width, height: 1 };
    }
    const height = imageAspect / targetAspect;
    return { x: 0, y: (1 - height) / 2, width: 1, height };
};

/**
 * Where an `object-contain` image lands inside a tile; the tile has bars when
 * its shape differs from the image's.
 */
export const containedBox = (
    imageAspect: number,
    boxWidth: number,
    boxHeight: number,
): ContainedBox => {
    if (imageAspect <= 0 || boxWidth <= 0 || boxHeight <= 0) {
        return { left: 0, top: 0, width: boxWidth, height: boxHeight };
    }
    if (boxWidth / boxHeight > imageAspect) {
        const width = boxHeight * imageAspect;
        return {
            left: (boxWidth - width) / 2,
            top: 0,
            width,
            height: boxHeight,
        };
    }
    const height = boxWidth / imageAspect;
    return {
        left: 0,
        top: (boxHeight - height) / 2,
        width: boxWidth,
        height,
    };
};

/**
 * Apply a drag of (`dx`, `dy`) normalized units to the crop box.
 *
 * `move` shifts the box inside the image. A corner moves its two edges, kept
 * inside the image and at least `minWidth` x `minHeight` so the box cannot
 * flip. A box already smaller than the minimum keeps its own size as the floor.
 */
export const dragCropRect = (
    start: NormalizedCropRect,
    handle: CropDragHandle,
    dx: number,
    dy: number,
    minWidth: number,
    minHeight: number,
): NormalizedCropRect => {
    if (handle === "move") {
        return {
            ...start,
            x: clamp(start.x + dx, 0, 1 - start.width),
            y: clamp(start.y + dy, 0, 1 - start.height),
        };
    }
    const floorWidth = Math.min(minWidth, start.width);
    const floorHeight = Math.min(minHeight, start.height);
    let left = start.x;
    let top = start.y;
    let right = start.x + start.width;
    let bottom = start.y + start.height;
    if (handle === "nw" || handle === "sw") {
        left = clamp(left + dx, 0, right - floorWidth);
    } else {
        right = clamp(right + dx, left + floorWidth, 1);
    }
    if (handle === "nw" || handle === "ne") {
        top = clamp(top + dy, 0, bottom - floorHeight);
    } else {
        bottom = clamp(bottom + dy, top + floorHeight, 1);
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
};

/**
 * Convert a normalized rectangle to source pixels. Pass the result through
 * `clampCropRect` before encoding.
 */
export const normalizedToPixelRect = (
    rect: NormalizedCropRect,
    imageWidth: number,
    imageHeight: number,
): CropRect => ({
    x: Math.round(rect.x * imageWidth),
    y: Math.round(rect.y * imageHeight),
    width: Math.round(rect.width * imageWidth),
    height: Math.round(rect.height * imageHeight),
});

export const countPendingCrops = (
    pending: Record<number, PendingCrop>,
): number => Object.keys(pending).length;

/**
 * Ask before discarding draft crops. Returns true when it is safe to exit.
 */
export const confirmDiscardPendingCrops = (
    pending: Record<number, PendingCrop>,
): boolean => {
    const count = countPendingCrops(pending);
    if (count === 0) {
        return true;
    }
    return window.confirm(
        count === 1 ?
            "Discard 1 pending crop?" :
            `Discard ${count} pending crops?`,
    );
};

const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);
