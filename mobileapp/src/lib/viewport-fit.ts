import type { Crop } from "react-image-crop";
import type { EnteFile } from "ente-media/file";
import { fileAspectRatio } from "@/lib/file-aspect-ratio";

/** Gallery reorder modes that surface images poorly matched to the viewer. */
export type ViewportFitSort = "none" | "blank-space" | "too-large";

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
 * Reorder files by how poorly they fit the viewer viewport.
 *
 * - `blank-space`: most object-contain blank (letterbox or pillarbox) first.
 * - `too-large`: most object-cover crop first (content lost to fill the frame).
 * - `none`: returns a shallow copy unchanged.
 *
 * Blank-space and too-large share the same mismatch magnitude (contain blank ≡
 * cover crop for a given aspect pair); both are offered so the Filter menu
 * matches the blank-vs-cropped mental model while curating.
 */
export const sortFilesByViewportFit = (
    files: EnteFile[],
    mode: ViewportFitSort,
    viewportAspect: number,
): EnteFile[] => {
    if (mode === "none") {
        return [...files];
    }
    const scoreFor =
        mode === "blank-space" ? viewportBlankFraction : viewportCropFraction;
    return [...files].sort((a, b) => {
        const scoreA = scoreFor(fileAspectRatio(a), viewportAspect);
        const scoreB = scoreFor(fileAspectRatio(b), viewportAspect);
        if (scoreB !== scoreA) {
            return scoreB - scoreA;
        }
        return a.id - b.id;
    });
};
