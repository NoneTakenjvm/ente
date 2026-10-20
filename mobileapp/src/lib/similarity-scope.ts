import type { EnteFile } from "ente-media/file";
import { fileUploadSortTime } from "@/core/metadata";

/**
 * Which photos a Similar run searches for. Each of them is still matched
 * against the whole library.
 */
export type SimilarScope =
    | { kind: "library" } |
    { kind: "latest"; count: number } |
    { kind: "picked" };

/** Offered "last N uploaded" sizes. */
export const LATEST_UPLOAD_COUNTS: readonly number[] = [50, 100, 250, 500, 1000];

/** Files newest-uploaded first. */
export const sortByUploadedNewestFirst = (
    files: readonly EnteFile[],
): EnteFile[] =>
    [...files].sort(
        (a, b) => fileUploadSortTime(b) - fileUploadSortTime(a) || b.id - a.id,
    );

/**
 * The candidate files a run searches for, in the order the scope lists them.
 *
 * @param candidates every file Similar can compare
 * @param pickedIds the hand-picked ids, used by the `picked` scope
 */
export const similarScopeFiles = (
    scope: SimilarScope,
    candidates: readonly EnteFile[],
    pickedIds: ReadonlySet<number>,
): EnteFile[] => {
    switch (scope.kind) {
        case "library":
            return [...candidates];
        case "latest":
            return sortByUploadedNewestFirst(candidates).slice(0, scope.count);
        case "picked":
            return candidates.filter((file) => pickedIds.has(file.id));
    }
};
