import type { Crop } from "react-image-crop";
import type { EnteFile } from "ente-media/file";
import { fileAspectRatio } from "@/lib/file-aspect-ratio";

/** Gallery reorder by how well each file matches the viewer aspect. */
export type ViewportFitSort = "none" | "best" | "worst";

/**
 * Aspect ratio (width / height) of the photo viewer media area on this device.
 *
 * Uses the visual viewport when available so mobile browser chrome is excluded.
 */
export const deviceViewerAspectRatio = (): number => {
    if (typeof window === "undefined") {
        return 1;
    }
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    if (width <= 0 || height <= 0) {
        return 1;
    }
    return width / height;
};

/**
 * Largest centered crop of {@link aspectRatio} that fits inside the display box.
 */
export const maxAspectRatioCrop = (
    displayWidth: number,
    displayHeight: number,
    aspectRatio: number,
): Crop => {
    if (displayWidth <= 0 || displayHeight <= 0 || aspectRatio <= 0) {
        return { unit: "px", x: 0, y: 0, width: 0, height: 0 };
    }
    const boxAspect = displayWidth / displayHeight;
    if (boxAspect > aspectRatio) {
        const height = displayHeight;
        const width = Math.max(1, Math.round(height * aspectRatio));
        return {
            unit: "px",
            x: Math.round((displayWidth - width) / 2),
            y: 0,
            width,
            height,
        };
    }
    const width = displayWidth;
    const height = Math.max(1, Math.round(width / aspectRatio));
    return {
        unit: "px",
        x: 0,
        y: Math.round((displayHeight - height) / 2),
        width,
        height,
    };
};

/**
 * Fraction of the viewer left empty when the image is shown with object-contain.
 */
export const viewportBlankFraction = (
    imageAspect: number,
    viewportAspect: number,
): number => {
    if (imageAspect <= 0 || viewportAspect <= 0) {
        return 0;
    }
    const ratio = imageAspect / viewportAspect;
    return ratio >= 1 ? 1 - 1 / ratio : 1 - ratio;
};

/**
 * Fraction of the image cropped away if the viewer filled the frame (object-cover).
 *
 * Equal to {@link viewportBlankFraction} for a given aspect pair.
 */
export const viewportCropFraction = (
    imageAspect: number,
    viewportAspect: number,
): number => viewportBlankFraction(imageAspect, viewportAspect);

/**
 * Reorder files by how well they fit the viewer viewport.
 *
 * - `best`: closest aspect match first (least blank / crop).
 * - `worst`: farthest aspect match first (most blank / crop).
 * - `none`: returns a shallow copy unchanged.
 *
 * Mismatch uses {@link viewportBlankFraction} (equal to cover-crop fraction for
 * a given aspect pair).
 */
export const sortFilesByViewportFit = (
    files: EnteFile[],
    mode: ViewportFitSort,
    viewportAspect: number,
): EnteFile[] => {
    if (mode === "none") {
        return [...files];
    }
    const ascending = mode === "best";
    const scoreById = new Map<number, number>();
    for (const file of files) {
        scoreById.set(
            file.id,
            viewportBlankFraction(fileAspectRatio(file), viewportAspect),
        );
    }
    return [...files].sort((a, b) => {
        const scoreA = scoreById.get(a.id) ?? 0;
        const scoreB = scoreById.get(b.id) ?? 0;
        if (scoreA !== scoreB) {
            return ascending ? scoreA - scoreB : scoreB - scoreA;
        }
        return a.id - b.id;
    });
};
