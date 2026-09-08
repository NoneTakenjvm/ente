import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type JSX,
} from "react";
import { TagClausePicker } from "@/components/TagClausePicker";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { TagQueryBuilderPanel } from "@/components/TagQueryBuilderPanel";
import { TagScopeFilterDropdown } from "@/components/TagScopeFilterDropdown";
import { Button } from "@/components/ui/button";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    countFavoritesInCandidates,
    countManuallyCroppedInCandidates,
    countNotFavoritesInCandidates,
    countNotManuallyCroppedInCandidates,
    countPhotosInCandidates,
    countTaggedInCandidates,
    countTagFilterClauses,
    countUntaggedInCandidates,
    countVideosInCandidates,
    describeTagFilter,
    isFlatTagFilterRoot,
    isTagFilterActive,
} from "@/lib/tags";
import { bulkAddTags, bulkRemoveTags } from "@/lib/tag-bulk-actions";
import { rankKitsByBestFitShareEmbedding } from "@/lib/kit-nearness-sort";
import { filterKitNearnessTags } from "@/lib/tag-types";
import { Shuffle } from "lucide-react";
import { SelectionModeToggle } from "@/components/SelectionModeToggle";
import { StampModeToggle } from "@/components/StampModeToggle";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";
import { useUIStore } from "@/stores/ui-store";
import type { TagPreset } from "@/lib/tag-presets";

interface TagFilterBarProps {
    matchCount: number;
    /** File ids currently matching the active filter (visible set). */
    matchingFileIds: number[];
}

export function TagFilterBar({
    matchCount,
    matchingFileIds,
}: TagFilterBarProps): JSX.Element {
    const allFiles = useLibraryStore((s) => s.allFiles);
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const tagFilter = useTagStore((s) => s.tagFilter);
    const setTagFilterMode = useTagStore((s) => s.setTagFilterMode);
    const setKitTagsMode = useTagStore((s) => s.setKitTagsMode);
    const setGroupOp = useTagStore((s) => s.setGroupOp);
    const clearFilters = useTagStore((s) => s.clearFilters);
    const knownTags = useTagStore((s) => s.tags);

    const selectAll = useSelectionStore((s) => s.selectAll);
    const setEnabled = useSelectionStore((s) => s.setEnabled);

    const presets = useTagSpeedStore((s) => s.presets);
    const includeInKitNearnessByName = useTagStore(
        (s) => s.includeInKitNearnessByName,
    );
    const pinnedTags = useTagSpeedStore((s) => s.pinnedTags);
    const togglePinnedTag = useTagSpeedStore((s) => s.togglePinnedTag);

    const mediaViewOrder = useUIStore((s) => s.mediaViewOrder);
    const setMediaShuffled = useUIStore((s) => s.setMediaShuffled);
    const setMediaDefaultOrder = useUIStore((s) => s.setMediaDefaultOrder);
    const viewportFitSort = useUIStore((s) => s.viewportFitSort);
    const setViewportFitSort = useUIStore((s) => s.setViewportFitSort);
    const imageSizeSort = useUIStore((s) => s.imageSizeSort);
    const setImageSizeSort = useUIStore((s) => s.setImageSizeSort);
    const kitNearnessPresetId = useUIStore((s) => s.kitNearnessPresetId);
    const setKitNearnessPresetId = useUIStore((s) => s.setKitNearnessPresetId);
    const reapplyKitNearness = useUIStore((s) => s.reapplyKitNearness);
    const setStampActive = useSelectionStore((s) => s.setStampActive);
    const setStampTags = useSelectionStore((s) => s.setStampTags);
    const setStampPickMode = useSelectionStore((s) => s.setStampPickMode);
    const setStampSheetOpen = useSelectionStore((s) => s.setStampSheetOpen);

    const embeddingEntries = useEmbeddingIndexStore((s) => s.entries);
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.hydrate);

    useEffect(() => {
        if (!presets.length || embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings, presets.length]);

    const kitNearnessPresets = useMemo((): TagPreset[] => {
        return presets
            .map((preset) => ({
                ...preset,
                tags: filterKitNearnessTags(
                    preset.tags,
                    includeInKitNearnessByName,
                ),
            }))
            .filter((preset) => preset.tags.length > 0);
    }, [includeInKitNearnessByName, presets]);

    const kitNearnessFitShareById = useMemo((): ReadonlyMap<string, number> => {
        if (!kitNearnessPresets.length || !embeddingHydrated) {
            return new Map();
        }
        const ranked = rankKitsByBestFitShareEmbedding(
            kitNearnessPresets,
            allFiles,
            embeddingEntries,
        );
        return new Map(ranked.map((row) => [row.presetId, row.share]));
    }, [allFiles, embeddingEntries, embeddingHydrated, kitNearnessPresets]);

    const handleKitNearnessPresetIdChange = useCallback(
        (presetId: string | undefined): void => {
            setKitNearnessPresetId(presetId);
            if (!presetId) {
                return;
            }
            const preset = presets.find((entry) => entry.id === presetId);
            if (!preset?.tags.length) {
                return;
            }
            setStampPickMode("kit");
            setStampTags(preset.tags);
            setStampActive(true);
            setStampSheetOpen(false);
        },
        [
            presets,
            setKitNearnessPresetId,
            setStampActive,
            setStampPickMode,
            setStampSheetOpen,
            setStampTags,
        ],
    );

    const [bulkTagOpen, setBulkTagOpen] = useState<boolean>(false);
    const [confirmBulkOpen, setConfirmBulkOpen] = useState<boolean>(false);
    const [pendingBulkTags, setPendingBulkTags] = useState<string[]>([]);
    const [bulkBusy, setBulkBusy] = useState<boolean>(false);
    const [bulkError, setBulkError] = useState<string | undefined>();

    const matchingFiles = useMemo(
        () => {
            const idSet = new Set(matchingFileIds);
            return allFiles.filter((file) => idSet.has(file.id));
        },
        [allFiles, matchingFileIds],
    );

    const isShuffled = mediaViewOrder === "shuffled";
    const filterActive = isTagFilterActive(tagFilter);

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

    const photoCount = useMemo(
        (): number => countPhotosInCandidates(libraryFileIds, allFiles),
        [libraryFileIds, allFiles],
    );

    const videoCount = useMemo(
        (): number => countVideosInCandidates(libraryFileIds, allFiles),
        [libraryFileIds, allFiles],
    );

    const croppedCount = useMemo(
        (): number => countManuallyCroppedInCandidates(libraryFileIds, allFiles),
        [libraryFileIds, allFiles],
    );

    const notCroppedCount = useMemo(
        (): number =>
            countNotManuallyCroppedInCandidates(libraryFileIds, allFiles),
        [libraryFileIds, allFiles],
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
        tagFilter.favoritesScope !== "all" ||
        tagFilter.mediaScope !== "all" ||
        tagFilter.croppedScope !== "all";

    const handleSelectAllMatching = useCallback((): void => {
        if (!matchingFileIds.length) {
            return;
        }
        selectAll(matchingFileIds);
    }, [matchingFileIds, selectAll]);

    const applyBulkTags = useCallback(
        async (tags: string[]): Promise<void> => {
            if (!tags.length || !matchingFileIds.length) {
                return;
            }
            setBulkBusy(true);
            setBulkError(undefined);
            try {
                await bulkAddTags(matchingFileIds, tags);
                setBulkTagOpen(false);
                setConfirmBulkOpen(false);
                setPendingBulkTags([]);
            } catch (error) {
                setBulkError(
                    error instanceof Error ?
                        error.message :
                        "Could not tag matching photos",
                );
            } finally {
                setBulkBusy(false);
            }
        },
        [matchingFileIds],
    );

    const requestBulkAdd = useCallback(
        (tagName: string): void => {
            if (matchCount > 25) {
                setPendingBulkTags([tagName]);
                setConfirmBulkOpen(true);
                return;
            }
            void applyBulkTags([tagName]);
        },
        [applyBulkTags, matchCount],
    );

    const requestBulkPreset = useCallback(
        (tags: string[]): void => {
            if (matchCount > 25) {
                setPendingBulkTags(tags);
                setConfirmBulkOpen(true);
                return;
            }
            void applyBulkTags(tags);
        },
        [applyBulkTags, matchCount],
    );

    return (
        <>
            <div className="flex flex-col gap-2 border-b border-border/60 px-4 py-3">
                <div className="flex flex-nowrap items-center justify-center gap-2 overflow-x-auto">
                    <TagScopeFilterDropdown
                        taggedCount={taggedCount}
                        untaggedCount={untaggedCount}
                        favoritesCount={favoritesCount}
                        notFavoritesCount={notFavoritesCount}
                        photoCount={photoCount}
                        videoCount={videoCount}
                        croppedCount={croppedCount}
                        notCroppedCount={notCroppedCount}
                        viewportFitSort={viewportFitSort}
                        onViewportFitSortChange={setViewportFitSort}
                        imageSizeSort={imageSizeSort}
                        onImageSizeSortChange={setImageSizeSort}
                        kitNearnessPresets={kitNearnessPresets}
                        kitNearnessPresetId={kitNearnessPresetId}
                        onKitNearnessPresetIdChange={handleKitNearnessPresetIdChange}
                        onKitNearnessReapply={reapplyKitNearness}
                        kitNearnessFitShareById={kitNearnessFitShareById}
                    />
                    <TagClausePicker
                        filter={tagFilter}
                        onSetTagFilterMode={setTagFilterMode}
                        onSetKitTagsMode={setKitTagsMode}
                        onSetRootOp={(op) => {
                            setGroupOp(tagFilter.root.id, op);
                        }}
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
                        photoCount={photoCount}
                        videoCount={videoCount}
                        croppedCount={croppedCount}
                        notCroppedCount={notCroppedCount}
                    />
                    <StampModeToggle />
                    <SelectionModeToggle />
                </div>
                {filterActive ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-muted-foreground">
                            {matchCount} photo{matchCount === 1 ? "" : "s"}
                            {" · "}
                            {describeTagFilter(tagFilter)}
                        </span>
                        <div className="flex flex-wrap items-center gap-1">
                            {matchCount > 0 ? (
                                <>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="xs"
                                        onClick={handleSelectAllMatching}
                                    >
                                        Select all
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="xs"
                                        onClick={() => {
                                            setBulkError(undefined);
                                            setBulkTagOpen(true);
                                            setEnabled(true);
                                        }}
                                    >
                                        Tag matching…
                                    </Button>
                                </>
                            ) : null}
                            <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={clearFilters}
                            >
                                Clear
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>

            <TagPickerSheet
                open={bulkTagOpen}
                appliedTags={[]}
                knownTags={knownTags}
                error={bulkError}
                presets={presets}
                kitScoreFiles={matchingFiles}
                defaultToKits={presets.length > 0}
                pinnedTags={pinnedTags}
                batchSelectionHint={
                    matchCount === 1 ?
                        "Add a kit or tags to the 1 matching photo." :
                        `Add a kit or tags to all ${matchCount} matching photos.`
                }
                onOpenChange={(open) => {
                    if (!open && !bulkBusy) {
                        setBulkTagOpen(false);
                        setBulkError(undefined);
                    }
                }}
                onAddTag={requestBulkAdd}
                onRemoveTag={(name) => {
                    void (async () => {
                        setBulkBusy(true);
                        try {
                            await bulkRemoveTags(matchingFileIds, [name]);
                        } catch (error) {
                            setBulkError(
                                error instanceof Error ?
                                    error.message :
                                    "Could not remove tag",
                            );
                        } finally {
                            setBulkBusy(false);
                        }
                    })();
                }}
                onApplyPreset={requestBulkPreset}
                onTogglePinTag={togglePinnedTag}
            />

            <AlertDialog
                open={confirmBulkOpen}
                onOpenChange={(open) => {
                    if (!open && !bulkBusy) {
                        setConfirmBulkOpen(false);
                        setPendingBulkTags([]);
                    }
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Tag {matchCount} matching photos?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            Apply{" "}
                            <span className="font-medium text-foreground">
                                {pendingBulkTags.join(", ")}
                            </span>{" "}
                            to every photo that matches the current filter.
                            You can undo from the toast afterward.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={bulkBusy}>
                            Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                            disabled={bulkBusy}
                            onClick={() => {
                                void applyBulkTags(pendingBulkTags);
                            }}
                        >
                            {bulkBusy ? "Working…" : "Tag all"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
