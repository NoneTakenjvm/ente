import type { RotationDegrees } from "@/lib/rotate";

export type PendingRotationDegrees = RotationDegrees;

/**
 * Advance a draft clockwise rotation by 90°. Returns undefined at 0° (cleared).
 */
export const nextPendingRotation = (
    current: PendingRotationDegrees | undefined,
): PendingRotationDegrees | undefined => {
    if (current === undefined) {
        return 90;
    }
    if (current === 90) {
        return 180;
    }
    if (current === 180) {
        return 270;
    }
    return undefined;
};

/**
 * CSS transform for a draft thumbnail rotation.
 * For 90/270 the image is scaled so the longer projected axis fits the square cell.
 */
export const previewTransformForRotation = (
    degrees: PendingRotationDegrees | 0,
    cellWidth: number,
    cellHeight: number,
): string | undefined => {
    if (degrees === 0) {
        return undefined;
    }
    const swap = degrees === 90 || degrees === 270;
    if (!swap || cellWidth <= 0 || cellHeight <= 0) {
        return `rotate(${degrees}deg)`;
    }
    // After 90/270 the image's visual width is cellHeight of content along cell width.
    // Scale so the rotated bounding box fits: min(cellW/cellH, cellH/cellW) when
    // the img fills the cell (object-contain already fits; scale keeps corners in).
    const scale = Math.min(cellWidth / cellHeight, cellHeight / cellWidth);
    return `rotate(${degrees}deg) scale(${scale})`;
};

export const countPendingRotations = (
    pending: Record<number, PendingRotationDegrees>,
): number => Object.keys(pending).length;

/**
 * Ask before discarding draft rotations. Returns true when it is safe to exit.
 */
export const confirmDiscardPendingRotations = (
    pending: Record<number, PendingRotationDegrees>,
): boolean => {
    const count = countPendingRotations(pending);
    if (count === 0) {
        return true;
    }
    return window.confirm(
        count === 1 ?
            "Discard 1 pending rotation?" :
            `Discard ${count} pending rotations?`,
    );
};
