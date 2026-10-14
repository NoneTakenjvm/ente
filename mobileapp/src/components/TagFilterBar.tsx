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
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
    countFavoritesInCandidates,
    countFileKindsInCandidates,
    countTagFilterClauses,
    countTaggedInCandidates,
    describeTagFilter,
    isFlatTagFilterRoot,
    isTagFilterActive,
    type TagFilterSelection,
} from "@/lib/tag-filter";
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
import { useUIStore, type GalleryOrdering } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";
import { errorMessage, plural } from "@/lib/format";

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
        (s) => s.typeConfig.includeInEffectsPresenceByName,
    );
    const includeInKitNearnessByName = useTagStore(
        (s) => s.typeConfig.includeInKitNearnessByName,
    );
    const knownTags = useTagStore((s) => s.tags);
    const {
        filter: tagFilter,
        setTagScope,
        setFavoritesScope,
        setMediaScope,
        setCroppedScope,
        setRotatedScope,
        setTagFilterMode,
        setKitMode,
        setGroupOp,
        clearFilters,
    } = useTagFilterBinding(filterTarget);

    const countFiles = scopeCandidateFiles ?? allFiles;

    const selectAll = useSelectionStore((s) => s.selectAll);
    const setSelectionMode = useSelectionStore((s) => s.setMode);
    const setStampTags = useSelectionStore((s) => s.setStampTags);
    const setStampPickMode = useSelectionStore((s) => s.setStampPickMode);
    const setStampSheetOpen = useSelectionStore((s) => s.setStampSheetOpen);

    const presets = useTagSpeedStore((s) => s.presets);
    const pinnedTags = useTagSpeedStore((s) => s.pinnedTags);
    const togglePinnedTag = useTagSpeedStore((s) => s.togglePinnedTag);

    const ordering = useUIStore((s) => s.ordering);
    const setOrdering = useUIStore((s) => s.setOrdering);
    const reapplyRelativeSort = useUIStore((s) => s.reapplyRelativeSort);
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
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.ensureHydrated);
    const qualityHydrated = useQualityIndexStore((s) => s.isHydrated);
    const hydrateQuality = useQualityIndexStore((s) => s.ensureHydrated);

    const nearnessFilter =
        ordering?.kind === "nearness" ? ordering.filter : undefined;
    const nearnessSource =
        ordering?.kind === "nearness" ? ordering.source : undefined;

    useEffect(() => {
        if (ordering?.kind !== "imageQuality" || qualityHydrated) {
            return;
        }
        void hydrateQuality();
    }, [hydrateQuality, ordering?.kind, qualityHydrated]);

    const needsEmbeddings =
        ordering?.kind === "tagFilterFit" ||
        ordering?.kind === "relative" ||
        ordering?.kind === "nearness" ||
        presets.length > 0;

    useEffect(() => {
        if (!needsEmbeddings || embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings, needsEmbeddings]);

    const matchingFileIds = useMemo(
        () => matchingFiles.map((file) => file.id),
        [matchingFiles],
    );

    /**
     * Shown files that fit each kit. Tag probabilities come from the worker;
     * counts are derived here so toggling a kit recounts immediately. Only
     * computed while the filter menu (where counts show) is open.
     */
    const [presenceEstimate, setPresenceEstimate] =
        useState<KitPresenceEstimate | null>(null);
    const [filterMenuOpen, setFilterMenuOpen] = useState<boolean>(false);

    useEffect(() => {
        if (!presets.length || !embeddingHydrated) {
            setPresenceEstimate(null);
            return;
        }
        if (!filterMenuOpen) {
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
                    if (!cancelled && estimate) {
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
        filterMenuOpen,
        fileIdsByTag,
        includeInKitNearnessByName,
        matchingFiles,
        presets,
    ]);

    const kitPresenceCountById = useMemo((): ReadonlyMap<string, number> => {
        if (!presets.length || !filterMenuOpen) {
            return new Map();
        }
        const estimate = presenceEstimate ?? {
            tagNames: [],
            candidateIds: [],
            tagProbabilities: new Float32Array(0),
        };
        return countKitPresence(
            presets,
            matchingFileIds,
            fileIdsByTag,
            estimate,
            excludedKitLikenessIds,
        );
    }, [
        excludedKitLikenessIds,
        fileIdsByTag,
        filterMenuOpen,
        matchingFileIds,
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

    const viewportFitSort =
        ordering?.kind === "viewportFit" ? ordering.direction : "none";
    const uploadedAtSort =
        ordering?.kind === "uploadedAt" ? ordering.direction : "none";
    const imageSizeSort =
        ordering?.kind === "imageSize" ? ordering.direction : "none";
    const imageQualitySort =
        ordering?.kind === "imageQuality" ? ordering.direction : "none";
    const tagFilterFitSort =
        ordering?.kind === "tagFilterFit" ? ordering.direction : "none";
    const relativeSort =
        ordering?.kind === "relative" ? ordering.direction : "none";

    // Kit deleted or tags no longer match — drop orphaned kit nearness.
    useEffect(() => {
        if (nearnessSource !== "kit" || !nearnessFilter) {
            return;
        }
        if (matchNearnessFilterToKitPreset(nearnessFilter, presets)) {
            return;
        }
        setOrdering(undefined);
    }, [nearnessFilter, nearnessSource, presets, setOrdering]);

    const handleFilterNearnessChange = useCallback(
        (filter: TagFilterSelection | undefined): void => {
            if (filter === undefined) {
                clearOrderingKind("nearness");
                return;
            }
            setOrdering({ kind: "nearness", filter, source: "filter" });
        },
        [setOrdering],
    );

    const handleKitLikenessPresetIdChange = useCallback(
        (presetId: string | undefined): void => {
            if (!presetId) {
                clearOrderingKind("nearness");
                return;
            }
            const preset = presets.find((entry) => entry.id === presetId);
            if (!preset?.tags.length) {
                return;
            }
            setOrdering({
                kind: "nearness",
                filter: nearnessFilterFromKitTags(preset.tags),
                source: "kit",
            });
            setStampPickMode("kit");
            setStampTags(preset.tags);
            setSelectionMode("stamp");
            setStampSheetOpen(false);
        },
        [
            presets,
            setOrdering,
            setSelectionMode,
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

    const isShuffled = ordering?.kind === "shuffled";
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

    const tagsButtonLabel =
        clauseCount === 0 ?
            "Tags" :
            `${plural(clauseCount, "tag")}`;

    const hasQueryContent =
        clauseCount > 0 ||
        tagFilter.tagScope !== "all" ||
        tagFilter.favoritesScope !== "all" ||
        tagFilter.mediaScope !== "all" ||
        tagFilter.croppedScope !== "all" ||
        tagFilter.rotatedScope !== "all";

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
                    errorMessage(error, "Could not tag matching photos"),
                );
            } finally {
                setBulkBusy(false);
            }
        },
        [matchingFileIds],
    );

    const requestBulkTags = useCallback(
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
                        rotatedScope={tagFilter.rotatedScope}
                        onRotatedScopeChange={setRotatedScope}
                        viewportFitSort={viewportFitSort}
                        onViewportFitSortChange={(direction) => {
                            if (direction === "none") {
                                clearOrderingKind("viewportFit");
                                return;
                            }
                            setOrdering({ kind: "viewportFit", direction });
                        }}
                        uploadedAtSort={uploadedAtSort}
                        onUploadedAtSortChange={(direction) => {
                            if (direction === "none") {
                                clearOrderingKind("uploadedAt");
                                return;
                            }
                            setOrdering({ kind: "uploadedAt", direction });
                        }}
                        imageSizeSort={imageSizeSort}
                        onImageSizeSortChange={(direction) => {
                            if (direction === "none") {
                                clearOrderingKind("imageSize");
                                return;
                            }
                            setOrdering({ kind: "imageSize", direction });
                        }}
                        imageQualitySort={imageQualitySort}
                        onImageQualitySortChange={(direction) => {
                            if (direction === "none") {
                                clearOrderingKind("imageQuality");
                                return;
                            }
                            setOrdering({ kind: "imageQuality", direction });
                        }}
                        tagFilterFitSort={tagFilterFitSort}
                        onTagFilterFitSortChange={
                            tagFilterFitAvailable ?
                                (direction) => {
                                    if (direction === "none") {
                                        clearOrderingKind("tagFilterFit");
                                        return;
                                    }
                                    setOrdering({
                                        kind: "tagFilterFit",
                                        direction,
                                    });
                                } :
                                undefined
                        }
                        relativeSort={relativeSort}
                        onRelativeSortChange={(direction) => {
                            if (direction === "none") {
                                clearOrderingKind("relative");
                                return;
                            }
                            // New random tip only when turning relative on.
                            setOrdering({
                                kind: "relative",
                                direction,
                                seed:
                                    ordering?.kind === "relative" ?
                                        ordering.seed :
                                        Date.now(),
                                startFileId:
                                    ordering?.kind === "relative" ?
                                        ordering.startFileId :
                                        undefined,
                            });
                        }}
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
                        onMenuOpenChange={setFilterMenuOpen}
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
                            setOrdering(
                                isShuffled ?
                                    undefined :
                                    {
                                        kind: "shuffled",
                                        seed: Date.now(),
                                        fileIds: [],
                                    },
                            );
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
                            {plural(matchCount, "photo")}
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
                onAddTag={(name) => requestBulkTags([name])}
                onRemoveTag={(name) => {
                    void (async () => {
                        setBulkBusy(true);
                        try {
                            await bulkRemoveTags(matchingFileIds, [name]);
                        } catch (error) {
                            setBulkError(
                                errorMessage(error, "Could not remove tag"),
                            );
                        } finally {
                            setBulkBusy(false);
                        }
                    })();
                }}
                onApplyPreset={requestBulkTags}
                onTogglePinTag={togglePinnedTag}
            />

            <ConfirmDialog
                open={confirmBulkOpen}
                title={`Tag ${matchCount} matching photos?`}
                description={
                    <>
                        Apply{" "}
                        <span className="font-medium text-foreground">
                            {pendingBulkTags.join(", ")}
                        </span>{" "}
                        to every photo that matches the current filter. You can
                        undo from the toast afterward.
                    </>
                }
                confirmLabel="Tag all"
                isWorking={bulkBusy}
                onCancel={() => {
                    setConfirmBulkOpen(false);
                    setPendingBulkTags([]);
                }}
                onConfirm={() => {
                    void applyBulkTags(pendingBulkTags);
                }}
            />
        </>
    );
}

/** Turn the ordering off, but only if it is currently of {@link kind}. */
const clearOrderingKind = (kind: GalleryOrdering["kind"]): void => {
    const { ordering, setOrdering } = useUIStore.getState();
    if (ordering?.kind === kind) {
        setOrdering(undefined);
    }
};
