import {
    startTransition,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { sortFilesByUpdatedAt } from "@/lib/updated-at-sort";
import {
    sortFilesByViewportFit,
    viewportTargetAspectRatio,
} from "@/lib/viewport-fit";
import { sortFilesByImageSize } from "@/lib/image-size-sort";
import { sortFilesByImageQuality } from "@/lib/image-quality";
import {
    packRelativeEmbeddings,
    sortFilesByRelative,
} from "@/lib/relative-sort";
import { sortRelativeIdsInWorker } from "@/lib/relative-sort-job";
import { KIT_EMBEDDING_DIMS } from "@/lib/kit-embedding";
import { sortFilesByTagFilterFit } from "@/lib/tag-filter-fit-sort";
import { isEnteVideoFile } from "@/lib/media-kind";
import { buildKitEmbeddingPrototypes } from "@/lib/kit-nearness-embedding-eval";
import { DEFAULT_KIT_EMBEDDING_GENOME } from "@/lib/kit-nearness-embedding-genome";
import {
    MAX_KIT_SEEDS,
    kitEmbeddingDistanceCompetitive,
    kitEmbeddingRivalWeights,
    listKitSeedFiles,
    pickKitEmbeddingMedoids,
    sortFilesByKitEmbeddingCompetitive,
} from "@/lib/kit-nearness-sort";
import {
    buildKitMarginsRanking,
    rankByKitMarginsInWorker,
    type KitMarginsRankingInput,
} from "@/lib/kit-nearness-margins-job";
import { matchNearnessFilterToKitPreset } from "@/lib/tag-presets";
import { imageFilesForPhash } from "@/lib/similarity-job";
import { runKitEmbeddingJob } from "@/lib/kit-embedding";
import { reconcileShuffledIds } from "@/lib/shuffle-files";
import {
    countTagFilterClauses,
    filterFilesByTags,
    isTagFilterActive,
    patchFilteredFilesForTagTouch,
    type TagFilterSelection,
} from "@/lib/tags";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useQualityIndexStore } from "@/stores/quality-index-store";
import { useSessionStore } from "@/stores/session-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";
import { useUIStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";
import { toast } from "sonner";

/** Keep a frozen id order; drop gone ids; append newcomers at the end. */
const reconcileFrozenFileOrder = (
    files: EnteFile[],
    orderIds: readonly number[],
): EnteFile[] => {
    if (!orderIds.length) {
        return files;
    }
    const byId = new Map(files.map((file) => [file.id, file]));
    const ordered: EnteFile[] = [];
    const seen = new Set<number>();
    for (const id of orderIds) {
        const file = byId.get(id);
        if (!file) {
            continue;
        }
        ordered.push(file);
        seen.add(id);
    }
    for (const file of files) {
        if (!seen.has(file.id)) {
            ordered.push(file);
        }
    }
    return ordered;
};

export interface MediaDisplayPipelineOptions {
    libraryFiles: EnteFile[];
    tagFilter: TagFilterSelection;
    /** Filter used by tag-fit sort and nearness context. */
    tagFilterForFitSort?: TagFilterSelection;
    /** When set, tagFilter narrows this set instead of the full library. */
    filterWithinFiles?: EnteFile[];
    /** Universe for nearness seed lookup. */
    seedWithinFiles?: EnteFile[];
    favoriteFileIds: Set<number>;
    initialLoadDone?: boolean;
    /** Clear nearness when the view unmounts (gallery / album view). */
    clearNearnessOnUnmount?: boolean;
}

export interface MediaDisplayPipelineResult {
    filteredFiles: EnteFile[];
    displayFiles: EnteFile[];
    matchCount: number;
}

/**
 * Shared filter cache, session sorts, and shuffle pipeline for gallery and albums.
 */
export function useMediaDisplayPipeline({
    libraryFiles,
    tagFilter,
    tagFilterForFitSort,
    filterWithinFiles,
    seedWithinFiles,
    favoriteFileIds,
    initialLoadDone = true,
    clearNearnessOnUnmount = false,
}: MediaDisplayPipelineOptions): MediaDisplayPipelineResult {
    const fitSortFilter = tagFilterForFitSort ?? tagFilter;
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const includeInEffectsPresenceByName = useTagStore(
        (s) => s.includeInEffectsPresenceByName,
    );
    const tagIndexRevision = useTagStore((s) => s.tagIndexRevision);
    const lastTagTouchFileIds = useTagStore((s) => s.lastTagTouchFileIds);

    const mediaViewOrder = useUIStore((s) => s.mediaViewOrder);
    const mediaShuffleSeed = useUIStore((s) => s.mediaShuffleSeed);
    const mediaShuffledFileIds = useUIStore((s) => s.mediaShuffledFileIds);
    const reconcileMediaShuffle = useUIStore((s) => s.reconcileMediaShuffle);
    const viewportFitSort = useUIStore((s) => s.viewportFitSort);
    const viewportTargetWidth = useUIStore((s) => s.viewportTargetWidth);
    const viewportTargetHeight = useUIStore((s) => s.viewportTargetHeight);
    const updatedAtSort = useUIStore((s) => s.updatedAtSort);
    const imageSizeSort = useUIStore((s) => s.imageSizeSort);
    const imageQualitySort = useUIStore((s) => s.imageQualitySort);
    const tagFilterFitSort = useUIStore((s) => s.tagFilterFitSort);
    const relativeSort = useUIStore((s) => s.relativeSort);
    const relativeSeed = useUIStore((s) => s.relativeSeed);
    const relativeStartFileId = useUIStore((s) => s.relativeStartFileId);
    const nearnessFilter = useUIStore((s) => s.nearnessFilter);
    const nearnessEpoch = useUIStore((s) => s.nearnessEpoch);
    const setNearnessFilter = useUIStore((s) => s.setNearnessFilter);

    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const embeddingCount = useEmbeddingIndexStore((s) => s.entries.size);
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.hydrate);
    const qualityEntries = useQualityIndexStore((s) => s.entries);
    const qualityHydrated = useQualityIndexStore((s) => s.isHydrated);
    const hydrateQuality = useQualityIndexStore((s) => s.hydrate);

    const nearnessActive =
        nearnessFilter !== undefined && isTagFilterActive(nearnessFilter);

    const baseFiles = filterWithinFiles ?? libraryFiles;
    const seedFiles = seedWithinFiles ?? filterWithinFiles ?? libraryFiles;

    const filterOptions = useMemo(
        () => ({
            favoriteFileIds,
            includeInEffectsPresenceByName,
        }),
        [favoriteFileIds, includeInEffectsPresenceByName],
    );

    useEffect(() => {
        if (imageQualitySort === "none" || qualityHydrated) {
            return;
        }
        void hydrateQuality();
    }, [hydrateQuality, imageQualitySort, qualityHydrated]);

    useEffect(() => {
        if (
            imageQualitySort === "none" ||
            !qualityHydrated ||
            qualityEntries.size > 0
        ) {
            return;
        }
        toast.message(
            "Run Manage → Settings → Scan image quality to score the library.",
        );
    }, [imageQualitySort, qualityEntries.size, qualityHydrated]);

    useEffect(() => {
        if (tagFilterFitSort === "none" || embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings, tagFilterFitSort]);

    useEffect(() => {
        if (
            relativeSort === "none" ||
            embeddingHydrated ||
            !initialLoadDone
        ) {
            return;
        }
        void hydrateEmbeddings();
    }, [
        embeddingHydrated,
        hydrateEmbeddings,
        initialLoadDone,
        relativeSort,
    ]);

    const viewerAspect = viewportTargetAspectRatio(
        viewportTargetWidth,
        viewportTargetHeight,
    );

    useEffect(() => {
        if (!nearnessFilter || isTagFilterActive(nearnessFilter)) {
            return;
        }
        setNearnessFilter(undefined);
    }, [nearnessFilter, setNearnessFilter]);

    useEffect(() => {
        if (!clearNearnessOnUnmount) {
            return;
        }
        return (): void => {
            useUIStore.getState().setNearnessFilter(undefined);
        };
    }, [clearNearnessOnUnmount]);

    useEffect(() => {
        if (!nearnessActive || embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings, nearnessActive]);

    useEffect(() => {
        if (!nearnessActive || !nearnessFilter || !embeddingHydrated || !initialLoadDone) {
            return;
        }
        let cancelled = false;
        const abort = new AbortController();

        void (async (): Promise<void> => {
            const userId = useSessionStore.getState().userID ?? 0;
            const tagState = useTagStore.getState();
            const seedMatches = filterFilesByTags(
                seedFiles,
                nearnessFilter,
                tagState.fileIdsByTag,
                {
                    favoriteFileIds:
                        useFavoritesStore.getState().favoriteFileIds,
                    includeInEffectsPresenceByName:
                        tagState.includeInEffectsPresenceByName,
                },
            );
            const seeds = imageFilesForPhash(seedMatches, userId)
                .sort((a, b) => a.id - b.id)
                .slice(0, MAX_KIT_SEEDS);
            if (seeds.length === 0) {
                toast.message(
                    "No photos match the nearness filter. Adjust tags or scopes.",
                );
                return;
            }

            let entries = useEmbeddingIndexStore.getState().entries;
            const missingSeeds = seeds.filter((file) => !entries.has(file.id));
            if (missingSeeds.length > 0) {
                const toastId = toast.loading(
                    `Embedding ${missingSeeds.length} seed photo${missingSeeds.length === 1 ? "" : "s"}…`,
                );
                try {
                    entries = await runKitEmbeddingJob({
                        files: missingSeeds,
                        userId,
                        existing: new Map(entries),
                        signal: abort.signal,
                    });
                } catch (error) {
                    if (!cancelled && !abort.signal.aborted) {
                        toast.dismiss(toastId);
                        toast.error(
                            error instanceof Error ?
                                error.message :
                                "Could not embed seed photos",
                        );
                    }
                    return;
                }
                if (cancelled || abort.signal.aborted) {
                    toast.dismiss(toastId);
                    return;
                }
                useEmbeddingIndexStore.getState().setEntries(entries);
                toast.dismiss(toastId);
                useUIStore.getState().reapplyNearness();
                return;
            }

            if (
                pickKitEmbeddingMedoids(
                    seeds.map((file) => file.id),
                    entries,
                ).length === 0
            ) {
                toast.message(
                    "Could not build nearness. Run Manage → Settings → Scan CLIP embeddings.",
                );
            }
        })();

        return (): void => {
            cancelled = true;
            abort.abort();
        };
        // Intentionally omit seedFiles: stamp/library patches must not re-embed
        // or bump nearness; Reapply (nearnessEpoch) is the rebuild trigger.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot on apply
    }, [
        embeddingHydrated,
        initialLoadDone,
        nearnessActive,
        nearnessEpoch,
        nearnessFilter,
    ]);

    const computeVisibleFiles = useCallback((): EnteFile[] => {
        if (!isTagFilterActive(tagFilter)) {
            return baseFiles;
        }
        return filterFilesByTags(
            baseFiles,
            tagFilter,
            useTagStore.getState().fileIdsByTag,
            {
                favoriteFileIds,
                includeInEffectsPresenceByName:
                    useTagStore.getState().includeInEffectsPresenceByName,
            },
        );
    }, [baseFiles, favoriteFileIds, tagFilter]);

    const frozenNearness = useMemo((): {
        orderIds: number[];
        marginsInput?: KitMarginsRankingInput;
    } => {
        const filter = useUIStore.getState().nearnessFilter;
        if (!filter || !isTagFilterActive(filter) || !embeddingHydrated) {
            return { orderIds: [] };
        }
        const embeddings = useEmbeddingIndexStore.getState().entries;
        const tagState = useTagStore.getState();
        const favoriteIds = useFavoritesStore.getState().favoriteFileIds;
        const options = {
            favoriteFileIds: favoriteIds,
            includeInEffectsPresenceByName:
                tagState.includeInEffectsPresenceByName,
        };
        const seedIds = filterFilesByTags(
            seedFiles,
            filter,
            tagState.fileIdsByTag,
            options,
        )
            .filter((file) => !isEnteVideoFile(file))
            .map((file) => file.id);
        const matchedKit = matchNearnessFilterToKitPreset(
            filter,
            useTagSpeedStore.getState().presets,
        );
        const selectedGenome =
            matchedKit?.nearnessTune?.genome ?? DEFAULT_KIT_EMBEDDING_GENOME;
        const selectedMedoids = buildKitEmbeddingPrototypes(
            seedIds,
            embeddings,
            selectedGenome,
        );
        if (!selectedMedoids.length) {
            return { orderIds: [] };
        }
        const filtered = computeVisibleFiles();
        const ui = useUIStore.getState();
        const useRivalPenalty =
            matchedKit !== undefined &&
            (ui.nearnessSource !== "kit" || ui.kitLikenessRivalPenalty);
        const rivalMedoidSets = useRivalPenalty ?
            useTagSpeedStore
                .getState()
                .presets.filter(
                    (entry) =>
                        entry.id !== matchedKit.id &&
                        !ui.excludedKitLikenessIds.has(entry.id),
                )
                .map((entry) => {
                    if (!entry.tags.length) {
                        return [];
                    }
                    const rivalGenome =
                        entry.nearnessTune?.genome ??
                        DEFAULT_KIT_EMBEDDING_GENOME;
                    return buildKitEmbeddingPrototypes(
                        listKitSeedFiles(seedFiles, entry.tags).map(
                            (file) => file.id,
                        ),
                        embeddings,
                        rivalGenome,
                    );
                })
                .filter((medoids) => medoids.length > 0) :
            [];
        const scoreOptions = {
            lambda: selectedGenome.rivalLambda,
            tau: selectedGenome.rivalTau,
        };
        const orderIds = sortFilesByKitEmbeddingCompetitive(
            filtered,
            selectedMedoids,
            rivalMedoidSets,
            embeddings,
            scoreOptions,
        ).map((file) => file.id);
        if (!matchedKit || !useRivalPenalty) {
            return { orderIds };
        }
        const rivalWeights = kitEmbeddingRivalWeights(
            selectedMedoids,
            rivalMedoidSets,
            scoreOptions.tau,
        );
        return {
            orderIds,
            marginsInput: {
                kitTags: matchedKit.tags,
                libraryFiles: seedFiles,
                candidateFiles: filtered,
                embeddings,
                fileIdsByTag: tagState.fileIdsByTag,
                includeInKitNearnessByName: tagState.includeInKitNearnessByName,
                productionScore: (fileId) =>
                    -kitEmbeddingDistanceCompetitive(
                        fileId,
                        selectedMedoids,
                        rivalMedoidSets,
                        embeddings,
                        { ...scoreOptions, rivalWeights },
                    ),
            },
        };
        // nearnessEpoch is the intentional rebuild trigger. Omit seedFiles /
        // computeVisibleFiles so stamp/library patches keep the frozen order
        // until the user clicks Reapply.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot only on apply
    }, [embeddingHydrated, nearnessEpoch, nearnessFilter]);

    const [learnedNearnessOrderIds, setLearnedNearnessOrderIds] = useState<
        number[]
    >([]);

    useEffect(() => {
        setLearnedNearnessOrderIds([]);
        const ranking =
            frozenNearness.marginsInput &&
            buildKitMarginsRanking(frozenNearness.marginsInput);
        if (!ranking) {
            return;
        }
        let cancelled = false;
        rankByKitMarginsInWorker(ranking)
            .then((orderIds) => {
                if (!cancelled) {
                    startTransition(() => setLearnedNearnessOrderIds(orderIds));
                }
            })
            .catch((error: unknown) => {
                console.warn("Kit nearness margins unavailable", error);
            });
        return (): void => {
            cancelled = true;
        };
    }, [frozenNearness]);

    const frozenNearnessOrderIds = learnedNearnessOrderIds.length ?
        learnedNearnessOrderIds :
        frozenNearness.orderIds;

    const [frozenRelativeOrderIds, setFrozenRelativeOrderIds] = useState<
        number[]
    >([]);
    const relativeJobRef = useRef(0);
    const relativeInsufficientToastKeyRef = useRef("");

    useEffect(() => {
        if (relativeSort === "none" || !embeddingHydrated) {
            relativeJobRef.current += 1;
            relativeInsufficientToastKeyRef.current = "";
            setFrozenRelativeOrderIds([]);
            return;
        }
        const jobId = relativeJobRef.current + 1;
        relativeJobRef.current = jobId;

        const embeddings = useEmbeddingIndexStore.getState().entries;
        const filtered = computeVisibleFiles();
        const withEmbeddingIds: number[] = [];
        for (const file of filtered) {
            const vector = embeddings.get(file.id);
            if (
                !isEnteVideoFile(file) &&
                vector?.length === KIT_EMBEDDING_DIMS
            ) {
                withEmbeddingIds.push(file.id);
            }
        }

        const applyOrder = (embeddedOrder: number[]): void => {
            if (jobId !== relativeJobRef.current) {
                return;
            }
            const embedded = new Set(embeddedOrder);
            const skipped: number[] = [];
            for (const file of filtered) {
                if (!embedded.has(file.id)) {
                    skipped.push(file.id);
                }
            }
            setFrozenRelativeOrderIds([...embeddedOrder, ...skipped]);
        };

        if (withEmbeddingIds.length < 2) {
            const toastKey = `${relativeSort}:${withEmbeddingIds.length}:${embeddingCount}`;
            if (relativeInsufficientToastKeyRef.current !== toastKey) {
                relativeInsufficientToastKeyRef.current = toastKey;
                toast.message(
                    "Need at least 2 CLIP-embedded photos in this view. Run Manage → Settings → Scan CLIP embeddings.",
                );
            }
            applyOrder(filtered.map((file) => file.id));
            return;
        }
        relativeInsufficientToastKeyRef.current = "";

        applyOrder(
            sortFilesByRelative(
                filtered,
                relativeSort,
                embeddings,
                relativeSeed,
                relativeStartFileId,
            ).map((file) => file.id),
        );

        if (withEmbeddingIds.length < 400) {
            return;
        }
        const packed = packRelativeEmbeddings(withEmbeddingIds, embeddings);
        void sortRelativeIdsInWorker(
            withEmbeddingIds,
            packed,
            relativeSort,
            relativeSeed,
            relativeStartFileId,
        )
            .then(applyOrder)
            .catch(() => {
                // Main-thread order already applied.
            });
        // Omit computeVisibleFiles: stamp/library patches must not rebuild the
        // snake; New start / mode / tip / embedding hydrate are the triggers.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot on apply
    }, [
        embeddingCount,
        embeddingHydrated,
        relativeSeed,
        relativeSort,
        relativeStartFileId,
    ]);

    const filteredFilesCacheRef = useRef<EnteFile[]>([]);
    const filterBasisRef = useRef<{
        tagFilter: TagFilterSelection;
        favoriteFileIds: Set<number>;
        includeInEffectsPresenceByName: ReadonlyMap<string, boolean> | undefined;
        baseFilesKey: string;
    } | undefined>(undefined);
    const baseFilesKey = useMemo(
        () => baseFiles.map((file) => file.id).join(","),
        [baseFiles],
    );

    const filteredFiles = useMemo(() => {
        void tagIndexRevision;
        if (!isTagFilterActive(tagFilter)) {
            filteredFilesCacheRef.current = baseFiles;
            filterBasisRef.current = {
                tagFilter,
                favoriteFileIds,
                includeInEffectsPresenceByName,
                baseFilesKey,
            };
            return baseFiles;
        }
        const basis = filterBasisRef.current;
        const filterUnchanged =
            basis?.tagFilter === tagFilter &&
            basis.favoriteFileIds === favoriteFileIds &&
            basis.includeInEffectsPresenceByName ===
                includeInEffectsPresenceByName &&
            basis.baseFilesKey === baseFilesKey;
        const touchIds = lastTagTouchFileIds;
        if (
            filterUnchanged &&
            touchIds?.length === 1 &&
            filteredFilesCacheRef.current.length
        ) {
            const patched = patchFilteredFilesForTagTouch(
                filteredFilesCacheRef.current,
                baseFiles,
                touchIds[0]!,
                tagFilter,
                fileIdsByTag,
                filterOptions,
            );
            if (patched) {
                filteredFilesCacheRef.current = patched;
                return patched;
            }
        }
        const next = filterFilesByTags(
            baseFiles,
            tagFilter,
            fileIdsByTag,
            filterOptions,
        );
        filteredFilesCacheRef.current = next;
        filterBasisRef.current = {
            tagFilter,
            favoriteFileIds,
            includeInEffectsPresenceByName,
            baseFilesKey,
        };
        return next;
    }, [
        baseFiles,
        baseFilesKey,
        favoriteFileIds,
        fileIdsByTag,
        filterOptions,
        includeInEffectsPresenceByName,
        lastTagTouchFileIds,
        tagFilter,
        tagIndexRevision,
    ]);

    const tagFilterFitActive =
        tagFilterFitSort !== "none" &&
        countTagFilterClauses(fitSortFilter.root) > 0;
    const relativeActive = relativeSort !== "none";

    useEffect(() => {
        if (
            mediaViewOrder !== "shuffled" ||
            viewportFitSort !== "none" ||
            updatedAtSort !== "none" ||
            imageSizeSort !== "none" ||
            imageQualitySort !== "none" ||
            tagFilterFitActive ||
            relativeActive ||
            nearnessActive
        ) {
            return;
        }
        reconcileMediaShuffle(filteredFiles.map((file) => file.id));
    }, [
        filteredFiles,
        imageQualitySort,
        imageSizeSort,
        mediaViewOrder,
        nearnessActive,
        reconcileMediaShuffle,
        relativeActive,
        tagFilterFitActive,
        updatedAtSort,
        viewportFitSort,
    ]);

    const computedOrderCacheRef = useRef<{
        kind: string;
        tagFilter: TagFilterSelection;
        ids: number[];
    }>({ kind: "", tagFilter, ids: [] });

    const displayFiles = useMemo(() => {
        const reuseComputedOrder = (
            kind: string,
            compute: () => EnteFile[],
        ): EnteFile[] => {
            const cache = computedOrderCacheRef.current;
            if (
                cache.kind === kind &&
                cache.tagFilter === tagFilter &&
                cache.ids.length > 0
            ) {
                return reconcileFrozenFileOrder(filteredFiles, cache.ids);
            }
            const sorted = compute();
            computedOrderCacheRef.current = {
                kind,
                tagFilter,
                ids: sorted.map((file) => file.id),
            };
            return sorted;
        };

        if (nearnessActive) {
            return reconcileFrozenFileOrder(filteredFiles, frozenNearnessOrderIds);
        }
        if (relativeActive) {
            return reconcileFrozenFileOrder(
                filteredFiles,
                frozenRelativeOrderIds,
            );
        }
        if (tagFilterFitActive) {
            return reuseComputedOrder(
                `fit:${tagFilterFitSort}:${embeddingHydrated ? "1" : "0"}`,
                () =>
                    sortFilesByTagFilterFit(
                        filteredFiles,
                        tagFilterFitSort,
                        useEmbeddingIndexStore.getState().entries,
                    ),
            );
        }
        if (imageSizeSort !== "none") {
            return reuseComputedOrder(
                `size:${imageSizeSort}`,
                () => sortFilesByImageSize(filteredFiles, imageSizeSort),
            );
        }
        if (imageQualitySort !== "none") {
            return reuseComputedOrder(
                `quality:${imageQualitySort}:${qualityHydrated ? "1" : "0"}:${qualityEntries.size}`,
                () =>
                    sortFilesByImageQuality(
                        filteredFiles,
                        imageQualitySort,
                        qualityEntries,
                    ),
            );
        }
        if (updatedAtSort !== "none") {
            return reuseComputedOrder(
                `updated:${updatedAtSort}`,
                () => sortFilesByUpdatedAt(filteredFiles, updatedAtSort),
            );
        }
        if (viewportFitSort !== "none") {
            return reuseComputedOrder(
                `viewport:${viewportFitSort}:${viewportTargetWidth}x${viewportTargetHeight}`,
                () =>
                    sortFilesByViewportFit(
                        filteredFiles,
                        viewportFitSort,
                        viewerAspect,
                    ),
            );
        }
        if (mediaViewOrder !== "shuffled") {
            return filteredFiles;
        }
        const fileIds = filteredFiles.map((file) => file.id);
        const orderedIds = reconcileShuffledIds(
            fileIds,
            mediaShuffleSeed,
            mediaShuffledFileIds.length > 0 ?
                mediaShuffledFileIds :
                undefined,
        );
        const byId = new Map(filteredFiles.map((file) => [file.id, file]));
        const ordered: EnteFile[] = [];
        for (const id of orderedIds) {
            const file = byId.get(id);
            if (file) {
                ordered.push(file);
            }
        }
        return ordered;
    }, [
        embeddingHydrated,
        filteredFiles,
        frozenNearnessOrderIds,
        frozenRelativeOrderIds,
        imageQualitySort,
        imageSizeSort,
        mediaShuffledFileIds,
        mediaShuffleSeed,
        mediaViewOrder,
        nearnessActive,
        qualityEntries,
        qualityHydrated,
        relativeActive,
        tagFilter,
        tagFilterFitActive,
        tagFilterFitSort,
        updatedAtSort,
        viewportFitSort,
        viewportTargetHeight,
        viewportTargetWidth,
        viewerAspect,
    ]);

    return {
        filteredFiles,
        displayFiles,
        matchCount: filteredFiles.length,
    };
}
