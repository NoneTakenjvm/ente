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

/** Which part of the crop box a drag grabbed: the body, a corner or an edge. */
export type CropDragHandle =
    | "move" |
    "nw" |
    "n" |
    "ne" |
    "e" |
    "se" |
    "s" |
    "sw" |
    "w";

/** Where the image sits inside a tile, in tile pixels. */
export interface ContainedBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * Largest centered crop of `targetAspect` that fits the image, as the
 * Falls back to the whole image.
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
 * `move` shifts the box inside the image. A corner moves its two edges and an
 * edge moves one, kept inside the image and at least `minWidth` x `minHeight`
 * so the box cannot flip. A box already smaller than the minimum keeps its own
 * size as the floor. With `lockedRatio` (normalized width / height) a resize
 * keeps that shape, anchored on the opposite corner or edge midpoint.
 */
export const dragCropRect = (
    start: NormalizedCropRect,
    handle: CropDragHandle,
    dx: number,
    dy: number,
    minWidth: number,
    minHeight: number,
    lockedRatio?: number,
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
    const west = handle.includes("w");
    const east = handle.includes("e");
    const north = handle.includes("n");
    const south = handle.includes("s");
    if (lockedRatio !== undefined && lockedRatio > 0) {
        return dragLockedCropRect(
            start,
            { west, east, north, south },
            dx,
            dy,
            Math.max(floorWidth, floorHeight * lockedRatio),
            lockedRatio,
        );
    }
    let left = start.x;
    let top = start.y;
    let right = start.x + start.width;
    let bottom = start.y + start.height;
    if (west) {
        left = clamp(left + dx, 0, right - floorWidth);
    } else if (east) {
        right = clamp(right + dx, left + floorWidth, 1);
    }
    if (north) {
        top = clamp(top + dy, 0, bottom - floorHeight);
    } else if (south) {
        bottom = clamp(bottom + dy, top + floorHeight, 1);
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
};

/**
 * Shrink `rect` about its center to the largest box of `ratio`
 * (normalized width / height) that fits inside it.
 */
export const fitRectToRatio = (
    rect: NormalizedCropRect,
    ratio: number,
): NormalizedCropRect => {
    if (ratio <= 0) {
        return rect;
    }
    const width = Math.min(rect.width, rect.height * ratio);
    const height = width / ratio;
    return {
        x: rect.x + (rect.width - width) / 2,
        y: rect.y + (rect.height - height) / 2,
        width,
        height,
    };
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

const countPendingCrops = (
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

interface MovedSides {
    west: boolean;
    east: boolean;
    north: boolean;
    south: boolean;
}

/**
 * Resize keeping `ratio`: the width follows the drag (the smaller of the two
 * axes for a corner), then is limited by the room left on the anchored sides.
 */
const dragLockedCropRect = (
    start: NormalizedCropRect,
    moved: MovedSides,
    dx: number,
    dy: number,
    floorWidth: number,
    ratio: number,
): NormalizedCropRect => {
    const { west, east, north, south } = moved;
    const horizontal = west ? -dx : east ? dx : undefined;
    const vertical = north ? -dy : south ? dy : undefined;
    const requestedWidth =
        horizontal !== undefined && vertical !== undefined ?
            Math.min(start.width + horizontal, (start.height + vertical) * ratio) :
            horizontal !== undefined ? start.width + horizontal :
                (start.height + (vertical ?? 0)) * ratio;
    const anchorX =
        west ? start.x + start.width :
            east ? start.x :
                start.x + start.width / 2;
    const anchorY =
        north ? start.y + start.height :
            south ? start.y :
                start.y + start.height / 2;
    const roomX = west ? anchorX : east ? 1 - anchorX : 2 * Math.min(anchorX, 1 - anchorX);
    const roomY = north ? anchorY : south ? 1 - anchorY : 2 * Math.min(anchorY, 1 - anchorY);
    const maxWidth = Math.min(roomX, roomY * ratio);
    const width = clamp(requestedWidth, Math.min(floorWidth, maxWidth), maxWidth);
    const height = width / ratio;
    return {
        x: west ? anchorX - width : east ? anchorX : anchorX - width / 2,
        y: north ? anchorY - height : south ? anchorY : anchorY - height / 2,
        width,
        height,
    };
};

const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);
