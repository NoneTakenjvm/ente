import { useMemo, type JSX } from "react";
import { TagClausePicker } from "@/components/TagClausePicker";
import { TagQueryBuilderPanel } from "@/components/TagQueryBuilderPanel";
import { TagScopeFilterDropdown } from "@/components/TagScopeFilterDropdown";
import { Button } from "@/components/ui/button";
import {
    countFavoritesInCandidates,
    countNotFavoritesInCandidates,
    countTaggedInCandidates,
    countTagFilterClauses,
    countUntaggedInCandidates,
    describeTagFilter,
    isFlatTagFilterRoot,
    isTagFilterActive,
} from "@/lib/tags";
import { Shuffle } from "lucide-react";
import { SelectionModeToggle } from "@/components/SelectionModeToggle";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useTagStore } from "@/stores/tag-store";
import { useUIStore } from "@/stores/ui-store";

interface TagFilterBarProps {
    matchCount: number;
}

export function TagFilterBar({
    matchCount,
}: TagFilterBarProps): JSX.Element {
    const allFiles = useLibraryStore((s) => s.allFiles);
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const tagFilter = useTagStore((s) => s.tagFilter);
    const setTagFilterMode = useTagStore((s) => s.setTagFilterMode);
    const clearFilters = useTagStore((s) => s.clearFilters);

    const mediaViewOrder = useUIStore((s) => s.mediaViewOrder);
    const setMediaShuffled = useUIStore((s) => s.setMediaShuffled);
    const setMediaDefaultOrder = useUIStore((s) => s.setMediaDefaultOrder);

    const isShuffled = mediaViewOrder === "shuffled";

    const libraryFileIds = useMemo(
        (): Set<number> => new Set(allFiles.map((file) => file.id)),
        [allFiles],
    );

    const untaggedCount = useMemo(
        (): number =>
            countUntaggedInCandidates(libraryFileIds, fileIdsByTag),
        [libraryFileIds, fileIdsByTag],
    );

    const taggedCount = useMemo(
        (): number =>
            countTaggedInCandidates(libraryFileIds, fileIdsByTag),
        [libraryFileIds, fileIdsByTag],
    );

    const favoritesCount = useMemo(
        (): number =>
            countFavoritesInCandidates(libraryFileIds, favoriteFileIds),
        [libraryFileIds, favoriteFileIds],
    );

    const notFavoritesCount = useMemo(
        (): number =>
            countNotFavoritesInCandidates(libraryFileIds, favoriteFileIds),
        [libraryFileIds, favoriteFileIds],
    );

    const clauseCount = countTagFilterClauses(tagFilter.root);
    const isFlat = isFlatTagFilterRoot(tagFilter.root);

    const tagsButtonLabel = useMemo((): string => {
        if (clauseCount === 0) {
            return "Tags";
        }
        return `${clauseCount} tag${clauseCount === 1 ? "" : "s"}`;
    }, [clauseCount]);

    const hasQueryContent =
        clauseCount > 0 ||
        tagFilter.tagScope !== "all" ||
        tagFilter.favoritesScope !== "all";

    return (
        <div className="flex flex-col gap-2 border-b border-border/60 px-4 py-3">
            <div className="flex flex-nowrap items-center justify-center gap-2 overflow-x-auto">
                <TagScopeFilterDropdown
                    taggedCount={taggedCount}
                    untaggedCount={untaggedCount}
                    favoritesCount={favoritesCount}
                    notFavoritesCount={notFavoritesCount}
                />
                <TagClausePicker
                    filter={tagFilter}
                    onSetTagFilterMode={setTagFilterMode}
                    triggerLabel={tagsButtonLabel}
                    triggerVariant={clauseCount > 0 ? "secondary" : "outline"}
                    disabled={!isFlat}
                />
                <Button
                    type="button"
                    variant={isShuffled ? "secondary" : "outline"}
                    size="sm"
                    className="gap-1.5"
                    aria-label={isShuffled ? "Disable random order" : "Randomise"}
                    aria-pressed={isShuffled}
                    onClick={() => {
                        if (isShuffled) {
                            setMediaDefaultOrder();
                        } else {
                            setMediaShuffled(Date.now());
                        }
                    }}
                >
                    <Shuffle className="size-3.5 shrink-0" />
                    <span>Randomise</span>
                </Button>
                <TagQueryBuilderPanel
                    hasQueryContent={hasQueryContent}
                    clauseCount={clauseCount}
                    favoritesCount={favoritesCount}
                    notFavoritesCount={notFavoritesCount}
                    taggedCount={taggedCount}
                    untaggedCount={untaggedCount}
                />
                <SelectionModeToggle />
            </div>
            {isTagFilterActive(tagFilter) ? (
                <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">
                        {matchCount} photo{matchCount === 1 ? "" : "s"}
                        {" · "}
                        {describeTagFilter(tagFilter)}
                    </span>
                    <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={clearFilters}
                    >
                        Clear
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
