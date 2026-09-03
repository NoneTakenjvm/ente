import type { EnteFile } from "ente-media/file";
import { filePixelArea } from "@/lib/file-aspect-ratio";

/** Gallery reorder by image pixel area (width × height), not file bytes. */
export type ImageSizeSort = "none" | "largest" | "smallest";

/**
 * Reorder files by pixel dimensions (area).
 *
 * - `largest`: biggest area first.
 * - `smallest`: smallest area first.
 * - `none`: returns a shallow copy unchanged.
 *
 * Files with unknown dimensions sort last for largest / first for smallest
 * (area treated as 0).
 */
export const sortFilesByImageSize = (
    files: EnteFile[],
    mode: ImageSizeSort,
): EnteFile[] => {
    if (mode === "none") {
        return [...files];
    }
    const descending = mode === "largest";
    return [...files].sort((a, b) => {
        const areaA = filePixelArea(a);
        const areaB = filePixelArea(b);
        if (areaA !== areaB) {
            return descending ? areaB - areaA : areaA - areaB;
        }
        return a.id - b.id;
    });
};
