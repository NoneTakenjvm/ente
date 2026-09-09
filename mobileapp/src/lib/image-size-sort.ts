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
    const areaById = new Map<number, number>();
    for (const file of files) {
        areaById.set(file.id, filePixelArea(file));
    }
    return [...files].sort((a, b) => {
        const areaA = areaById.get(a.id) ?? 0;
        const areaB = areaById.get(b.id) ?? 0;
        if (areaA !== areaB) {
            return descending ? areaB - areaA : areaA - areaB;
        }
        return a.id - b.id;
    });
};
