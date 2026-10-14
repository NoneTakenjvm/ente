import type { EnteFile } from "ente-media/file";
import { fileAspectRatio } from "@/lib/file-aspect-ratio";
import { sortFilesByScore } from "@/lib/sort-files";

/** Gallery reorder by how well each file matches the viewer aspect. */
export type ViewportFitSort = "none" | "best" | "worst";

/** CSS pixel size of the visual viewport (or window when unavailable). */
export type ViewerSize = { width: number; height: number };

/**
 * Live visual-viewport size on this device (CSS px).
 *
 * Uses the visual viewport when available so mobile browser chrome is excluded.
 * SSR-safe: returns `{ width: 1, height: 1 }` when `window` is missing.
 */
export const deviceViewerSize = (): ViewerSize => {
    if (typeof window === "undefined") {
        return { width: 1, height: 1 };
    }
    const viewport = window.visualViewport;
    const width = Math.round(viewport?.width ?? window.innerWidth);
    const height = Math.round(viewport?.height ?? window.innerHeight);
    if (width <= 0 || height <= 0) {
        return { width: 1, height: 1 };
    }
    return { width, height };
};

/**
 * Aspect ratio (width / height) for a configured or live viewport size.
 */
export const viewportTargetAspectRatio = (
    width: number,
    height: number,
): number => {
    if (width <= 0 || height <= 0) {
        return 1;
    }
    return width / height;
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
 * Reorder files by how well they fit the viewer viewport.
 *
 * - `best`: closest aspect match first (least blank / crop).
 * - `worst`: farthest aspect match first (most blank / crop).
 *
 * Mismatch uses {@link viewportBlankFraction} (equal to cover-crop fraction for
 * a given aspect pair).
 */
export const sortFilesByViewportFit = (
    files: EnteFile[],
    direction: Exclude<ViewportFitSort, "none">,
    viewportAspect: number,
): EnteFile[] =>
    sortFilesByScore(
        files,
        (file) => viewportBlankFraction(fileAspectRatio(file), viewportAspect),
        direction === "best",
        false,
    );
