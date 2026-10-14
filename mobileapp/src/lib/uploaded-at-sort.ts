import type { EnteFile } from "ente-media/file";
import { fileUploadSortTime } from "@/lib/sort-files";

/** Gallery reorder by upload time (session-only). */
export type UploadedAtSort = "none" | "newest" | "oldest";

/**
 * Reorder files by upload time (see {@link fileUploadSortTime}).
 *
 * - `newest`: most recently uploaded first.
 * - `oldest`: least recently uploaded first.
 * - `none`: returns a shallow copy unchanged.
 */
export const sortFilesByUploadedAt = (
    files: EnteFile[],
    mode: UploadedAtSort,
): EnteFile[] => {
    if (mode === "none") {
        return [...files];
    }
    const descending = mode === "newest";
    return [...files].sort((a, b) => {
        const timeA = fileUploadSortTime(a);
        const timeB = fileUploadSortTime(b);
        if (timeA !== timeB) {
            return descending ? timeB - timeA : timeA - timeB;
        }
        return a.id - b.id;
    });
};
