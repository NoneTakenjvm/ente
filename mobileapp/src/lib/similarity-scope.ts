import type { EnteFile } from "ente-media/file";
import { fileUploadSortTime } from "@/core/metadata";

/**
 * Which photos a Similar run searches for. Each of them is still matched
 * against the whole library.
 */
export type SimilarScope =
    | { kind: "library" } |
    { kind: "uploadedWithin"; hours: number } |
    { kind: "latest"; count: number } |
    { kind: "picked" };

/** The "Recent" scopes: a window of upload time or a number of uploads. */
export type RecentScope = Extract<
    SimilarScope,
    { kind: "uploadedWithin" | "latest" }
>;

/** Offered "Recent" scopes, by upload time first, then by count. */
export const RECENT_SCOPES: readonly RecentScope[] = [
    { kind: "uploadedWithin", hours: 24 },
    { kind: "uploadedWithin", hours: 24 * 3 },
    { kind: "uploadedWithin", hours: 24 * 7 },
    { kind: "uploadedWithin", hours: 24 * 30 },
    { kind: "latest", count: 100 },
    { kind: "latest", count: 500 },
];

/** "Last 24 hours", "Last 7 days" or "Last 100 uploads". */
export const recentScopeLabel = (scope: RecentScope): string => {
    if (scope.kind === "latest") {
        return `Last ${scope.count} uploads`;
    }
    return scope.hours > 24 && scope.hours % 24 === 0 ?
        `Last ${scope.hours / 24} days` :
        `Last ${scope.hours} hours`;
};

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
 * @param now epoch milliseconds that `uploadedWithin` counts back from
 */
export const similarScopeFiles = (
    scope: SimilarScope,
    candidates: readonly EnteFile[],
    pickedIds: ReadonlySet<number>,
    now: number = Date.now(),
): EnteFile[] => {
    switch (scope.kind) {
        case "library":
            return [...candidates];
        case "uploadedWithin": {
            // Upload times are epoch microseconds.
            const cutoff = (now - scope.hours * 60 * 60 * 1000) * 1000;
            return sortByUploadedNewestFirst(
                candidates.filter((file) => fileUploadSortTime(file) >= cutoff),
            );
        }
        case "latest":
            return sortByUploadedNewestFirst(candidates).slice(0, scope.count);
        case "picked":
            return candidates.filter((file) => pickedIds.has(file.id));
    }
};
