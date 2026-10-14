import { useMemo, type JSX } from "react";
import { DedupGroupReview } from "@/components/manage/DedupGroupReview";
import {
    exactGroupToSelection,
    findExactDuplicateGroups,
    sumPrunableStats,
} from "@/lib/exact-duplicates";
import { formatFileSize, plural } from "@/lib/format";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useQualityIndexStore } from "@/stores/quality-index-store";
import { useSessionStore } from "@/stores/session-store";

interface ManageDuplicatesPanelProps {
    showLoader: boolean;
}

/**
 * Byte-identical duplicate groups with keeper selection and cleanup.
 */
export function ManageDuplicatesPanel({
    showLoader,
}: ManageDuplicatesPanelProps): JSX.Element {
    const userId = useSessionStore((s) => s.userID) ?? 0;
    const allFiles = useLibraryStore((s) => s.allFiles);
    const collections = useLibraryStore((s) => s.collections);
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    const qualityById = useQualityIndexStore((s) => s.entries);

    const exactGroups = useMemo(
        () => findExactDuplicateGroups(allFiles, collections, userId),
        [allFiles, collections, userId],
    );

    const groups = useMemo(
        () =>
            exactGroups.map((group) =>
                exactGroupToSelection(group, true, {
                    favoriteFileIds,
                    qualityById,
                })),
        [exactGroups, favoriteFileIds, qualityById],
    );

    return (
        <DedupGroupReview
            groups={groups}
            showLoader={showLoader}
            emptyTitle="No exact duplicates"
            emptyDescription="No exact duplicates found in your library."
            groupSubtitle={(group) =>
                `~${formatFileSize(
                    (group.items.length - 1) *
                          (group.items[0]?.file.info?.fileSize ?? 0),
                )}`}
        >
            {(selections) => {
                const exactStats = sumPrunableStats(
                    exactGroups,
                    selections.map((group) => group.isSelected),
                );
                return (
                    <p className="text-xs text-muted-foreground">
                        {plural(exactGroups.length, "duplicate group")} ·{" "}
                        {plural(exactStats.count, "file")} selected · ~
                        {formatFileSize(exactStats.size)} reclaimable
                    </p>
                );
            }}
        </DedupGroupReview>
    );
}
