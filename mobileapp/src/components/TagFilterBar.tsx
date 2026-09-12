import {
    useCallback,
    useDeferredValue,
    useEffect,
    useMemo,
    useState,
    type JSX,
} from "react";
import { TagClausePicker } from "@/components/TagClausePicker";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { GalleryToolsMenu } from "@/components/GalleryToolsMenu";
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
    countFileKindsInCandidates,
    countTagFilterClauses,
    countTaggedInCandidates,
    describeTagFilter,
    isFlatTagFilterRoot,
    isTagFilterActive,
    type TagFilterSelection,
} from "@/lib/tags";
import { bulkAddTags, bulkRemoveTags } from "@/lib/tag-bulk-actions";
import { countKitPresence, type KitPresenceEstimate } from "@/lib/kit-nearness-margins";
import { estimateKitPresenceInWorker } from "@/lib/kit-nearness-margins-job";
import {
    matchNearnessFilterToKitPreset,
    nearnessFilterFromKitTags,
} from "@/lib/tag-presets";
import { Shuffle } from "lucide-react";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useQualityIndexStore } from "@/stores/quality-index-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagFilterBinding } from "@/hooks/use-tag-filter-binding";
import { useTagStore } from "@/stores/tag-store";
import type { TagFilterTarget } from "@/stores/tag-store";
import { useUIStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";

interface TagFilterBarProps {
    matchCount: number;
    /** Files currently matching the active filter (visible set). */
    matchingFiles: EnteFile[];
    filterTarget?: TagFilterTarget;
    /** Files to count scope filters against; defaults to the full library. */
    scopeCandidateFiles?: EnteFile[];
    /** Filter whose clauses enable tag-fit sort (album query when refining). */
    tagFilterFitSource?: TagFilterSelection;
}

export function TagFilterBar({
    matchCount,
    matchingFiles,
    filterTarget = "gallery",
    scopeCandidateFiles,
    tagFilterFitSource,
}: TagFilterBarProps): JSX.Element {
    const allFiles = useLibraryStore((s) => s.allFiles);
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    // Defer the favourites count so starring stays snappy; the badge can lag a frame.
    const deferredFavoriteFileIds = useDeferredValue(favoriteFileIds);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const includeInEffectsPresenceByName = useTagStore(
        (s) => s.includeInEffectsPresenceByName,
    );
    const includeInKitNearnessByName = useTagStore(
        (s) => s.includeInKitNearnessByName,
    );
    const knownTags = useTagStore((s) => s.tags);
    const {
        filter: tagFilter,
        setTagScope,
        setFavoritesScope,
        setMediaScope,
        setCroppedScope,
        setTagFilterMode,
        setKitMode,
        setGroupOp,
        clearFilters,
    } = useTagFilterBinding(filterTarget);

    const countFiles = scopeCandidateFiles ?? allFiles;

    const selectAll = useSelectionStore((s) => s.selectAll);
    const setStampActive = useSelectionStore((s) => s.setStampActive);
    const setStampTags = useSelectionStore((s) => s.setStampTags);
    const setStampPickMode = useSelectionStore((s) => s.setStampPickMode);
    const setStampSheetOpen = useSelectionStore((s) => s.setStampSheetOpen);

    const presets = useTagSpeedStore((s) => s.presets);
    const pinnedTags = useTagSpeedStore((s) => s.pinnedTags);
    const togglePinnedTag = useTagSpeedStore((s) => s.togglePinnedTag);

    const mediaViewOrder = useUIStore((s) => s.mediaViewOrder);
    const setMediaShuffled = useUIStore((s) => s.setMediaShuffled);
    const setMediaDefaultOrder = useUIStore((s) => s.setMediaDefaultOrder);
    const viewportFitSort = useUIStore((s) => s.viewportFitSort);
    const setViewportFitSort = useUIStore((s) => s.setViewportFitSort);
    const updatedAtSort = useUIStore((s) => s.updatedAtSort);
    const setUpdatedAtSort = useUIStore((s) => s.setUpdatedAtSort);
    const imageSizeSort = useUIStore((s) => s.imageSizeSort);
    const setImageSizeSort = useUIStore((s) => s.setImageSizeSort);
    const imageQualitySort = useUIStore((s) => s.imageQualitySort);
    const setImageQualitySort = useUIStore((s) => s.setImageQualitySort);
    const tagFilterFitSort = useUIStore((s) => s.tagFilterFitSort);
    const setTagFilterFitSort = useUIStore((s) => s.setTagFilterFitSort);
    const relativeSort = useUIStore((s) => s.relativeSort);
    const setRelativeSort = useUIStore((s) => s.setRelativeSort);
    const reapplyRelativeSort = useUIStore((s) => s.reapplyRelativeSort);
    const nearnessFilter = useUIStore((s) => s.nearnessFilter);
    const nearnessSource = useUIStore((s) => s.nearnessSource);
    const setNearnessFilter = useUIStore((s) => s.setNearnessFilter);
    const reapplyNearness = useUIStore((s) => s.reapplyNearness);
    const kitLikenessRivalPenalty = useUIStore(
        (s) => s.kitLikenessRivalPenalty,
    );
    const setKitLikenessRivalPenalty = useUIStore(
        (s) => s.setKitLikenessRivalPenalty,
    );
    const excludedKitLikenessIds = useUIStore(
        (s) => s.excludedKitLikenessIds,
    );
    const toggleKitLikenessExcluded = useUIStore(
        (s) => s.toggleKitLikenessExcluded,
    );

    const embeddingCount = useEmbeddingIndexStore((s) => s.entries.size);
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.hydrate);
    const qualityHydrated = useQualityIndexStore((s) => s.isHydrated);
    const hydrateQuality = useQualityIndexStore((s) => s.hydrate);

    useEffect(() => {
        if (imageQualitySort === "none" || qualityHydrated) {
            return;
        }
        void hydrateQuality();
    }, [hydrateQuality, imageQualitySort, qualityHydrated]);

    useEffect(() => {
        if (tagFilterFitSort === "none" || embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings, tagFilterFitSort]);

    useEffect(() => {
        if (relativeSort === "none" || embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings, relativeSort]);

    useEffect(() => {
        if (!nearnessFilter || embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings, nearnessFilter]);

    useEffect(() => {
        if (!presets.length || embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings, presets.length]);

    const matchingFileIds = useMemo(
        () => matchingFiles.map((file) => file.id),
        [matchingFiles],
    );

    /**
     * Shown files that fit each kit. Tag probabilities come from the worker;
     * counts are derived here so toggling a kit recounts immediately.
     */
    const [presenceEstimate, setPresenceEstimate] =
        useState<KitPresenceEstimate | null>(null);

    useEffect(() => {
        if (!presets.length || !embeddingHydrated) {
            setPresenceEstimate(null);
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            estimateKitPresenceInWorker({
                kits: presets,
                libraryFiles: allFiles,
                viewFiles: matchingFiles,
                embeddings: useEmbeddingIndexStore.getState().entries,
                fileIdsByTag,
                includeInKitNearnessByName,
            })
                .then((estimate) => {
                    if (!cancelled) {
                        setPresenceEstimate(estimate);
                    }
                })
                .catch((error: unknown) => {
                    console.warn("Kit presence unavailable", error);
                });
        }, 160);
        return (): void => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [
        allFiles,
        embeddingCount,
        embeddingHydrated,
        fileIdsByTag,
        includeInKitNearnessByName,
        matchingFiles,
        presets,
    ]);

    const kitPresenceCountById = useMemo((): ReadonlyMap<string, number> => {
        if (!presets.length) {
            return new Map();
        }
        const estimate = presenceEstimate ?? {
            tagNames: [],
            candidateIds: [],
            tagProbabilities: new Float32Array(0),
        };
        return countKitPresence(
            presets,
            matchingFiles.map((file) => file.id),
            fileIdsByTag,
            estimate,
            excludedKitLikenessIds,
        );
    }, [
        excludedKitLikenessIds,
        fileIdsByTag,
        matchingFiles,
        presenceEstimate,
        presets,
    ]);

    const kitLikenessPresetId = useMemo((): string | undefined => {
        if (
            nearnessSource !== "kit" ||
            !nearnessFilter ||
            !isTagFilterActive(nearnessFilter)
        ) {
            return undefined;
        }
        return matchNearnessFilterToKitPreset(nearnessFilter, presets)?.id;
    }, [nearnessFilter, nearnessSource, presets]);

    // Kit deleted or tags no longer match — drop orphaned kit nearness.
    useEffect(() => {
        if (nearnessSource !== "kit" || !nearnessFilter) {
            return;
        }
        if (matchNearnessFilterToKitPreset(nearnessFilter, presets)) {
            return;
        }
        setNearnessFilter(undefined);
    }, [nearnessFilter, nearnessSource, presets, setNearnessFilter]);

    const handleFilterNearnessChange = useCallback(
        (filter: TagFilterSelection | undefined): void => {
            if (filter === undefined) {
                setNearnessFilter(undefined);
                return;
            }
            setNearnessFilter(filter, "filter");
        },
        [setNearnessFilter],
    );

    const handleKitLikenessPresetIdChange = useCallback(
        (presetId: string | undefined): void => {
            if (!presetId) {
                setNearnessFilter(undefined);
                return;
            }
            const preset = presets.find((entry) => entry.id === presetId);
            if (!preset?.tags.length) {
                return;
            }
            setNearnessFilter(nearnessFilterFromKitTags(preset.tags), "kit");
            setStampPickMode("kit");
            setStampTags(preset.tags);
            setStampActive(true);
            setStampSheetOpen(false);
        },
        [
            presets,
            setNearnessFilter,
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

    const isShuffled = mediaViewOrder === "shuffled";
    const filterActive = isTagFilterActive(tagFilter);

    const libraryFileIds = useMemo(
        (): Set<number> => new Set(countFiles.map((file) => file.id)),
        [countFiles],
    );

    const taggedCount = useMemo(
        (): number =>
            countTaggedInCandidates(
                libraryFileIds,
                fileIdsByTag,
                includeInEffectsPresenceByName,
            ),
        [libraryFileIds, fileIdsByTag, includeInEffectsPresenceByName],
    );
    const untaggedCount = libraryFileIds.size - taggedCount;

    const favoritesCount = useMemo(
        (): number =>
            countFavoritesInCandidates(libraryFileIds, deferredFavoriteFileIds),
        [libraryFileIds, deferredFavoriteFileIds],
    );

    const notFavoritesCount = libraryFileIds.size - favoritesCount;

    const fileKindCounts = useMemo(
        (): ReturnType<typeof countFileKindsInCandidates> =>
            countFileKindsInCandidates(libraryFileIds, countFiles),
        [countFiles, libraryFileIds],
    );

    const photoCount = fileKindCounts.photos;
    const videoCount = fileKindCounts.videos;
    const croppedCount = fileKindCounts.cropped;
    const notCroppedCount = fileKindCounts.notCropped;

    const clauseCount = countTagFilterClauses(tagFilter.root);
    const isFlat = isFlatTagFilterRoot(tagFilter.root);
    const fitClauseCount = countTagFilterClauses(
        (tagFilterFitSource ?? tagFilter).root,
    );
    // Keep latched mode when clauses drop to zero; only hide the Sort radios.
    const tagFilterFitAvailable = fitClauseCount > 0;

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
                        tagScope={tagFilter.tagScope}
                        onTagScopeChange={setTagScope}
                        favoritesScope={tagFilter.favoritesScope}
                        onFavoritesScopeChange={setFavoritesScope}
                        mediaScope={tagFilter.mediaScope}
                        onMediaScopeChange={setMediaScope}
                        croppedScope={tagFilter.croppedScope}
                        onCroppedScopeChange={setCroppedScope}
                        viewportFitSort={viewportFitSort}
                        onViewportFitSortChange={setViewportFitSort}
                        updatedAtSort={updatedAtSort}
                        onUpdatedAtSortChange={setUpdatedAtSort}
                        imageSizeSort={imageSizeSort}
                        onImageSizeSortChange={setImageSizeSort}
                        imageQualitySort={imageQualitySort}
                        onImageQualitySortChange={setImageQualitySort}
                        tagFilterFitSort={tagFilterFitSort}
                        onTagFilterFitSortChange={
                            tagFilterFitAvailable ?
                                setTagFilterFitSort :
                                undefined
                        }
                        relativeSort={relativeSort}
                        onRelativeSortChange={setRelativeSort}
                        onRelativeReapply={reapplyRelativeSort}
                        nearnessFilter={nearnessFilter}
                        onNearnessFilterChange={handleFilterNearnessChange}
                        onNearnessReapply={reapplyNearness}
                        nearnessSource={nearnessSource}
                        kitLikenessPresets={presets}
                        kitLikenessPresetId={kitLikenessPresetId}
                        onKitLikenessPresetIdChange={
                            handleKitLikenessPresetIdChange
                        }
                        kitPresenceCountById={kitPresenceCountById}
                        excludedKitLikenessIds={excludedKitLikenessIds}
                        onToggleKitLikenessExcluded={toggleKitLikenessExcluded}
                        kitLikenessRivalPenalty={kitLikenessRivalPenalty}
                        onKitLikenessRivalPenaltyChange={
                            setKitLikenessRivalPenalty
                        }
                    />
                    <TagClausePicker
                        filter={tagFilter}
                        onSetTagFilterMode={setTagFilterMode}
                        onSetKitMode={setKitMode}
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
                    <GalleryToolsMenu
                        filterTarget={filterTarget}
                        query={{
                            hasQueryContent,
                            favoritesCount,
                            notFavoritesCount,
                            taggedCount,
                            untaggedCount,
                            photoCount,
                            videoCount,
                            croppedCount,
                            notCroppedCount,
                        }}
                    />
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
