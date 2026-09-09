import type { EnteFile } from "ente-media/file";
import { fileUpdateSortTime } from "@/lib/sort-files";

/** Gallery reorder by last metadata/tag update time (session-only). */
export type UpdatedAtSort = "none" | "newest" | "oldest";

/**
 * Reorder files by last update time (tags, edits, or server updation).
 *
 * - `newest`: most recently updated first.
 * - `oldest`: least recently updated first.
 * - `none`: returns a shallow copy unchanged.
 */
export const sortFilesByUpdatedAt = (
    files: EnteFile[],
    mode: UpdatedAtSort,
): EnteFile[] => {
    if (mode === "none") {
        return [...files];
    }
    const descending = mode === "newest";
    return [...files].sort((a, b) => {
        const timeA = fileUpdateSortTime(a);
        const timeB = fileUpdateSortTime(b);
        if (timeA !== timeB) {
            return descending ? timeB - timeA : timeA - timeB;
        }
        return a.id - b.id;
    });
};
