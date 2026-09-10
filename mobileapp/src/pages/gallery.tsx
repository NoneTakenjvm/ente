import {
    startTransition,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import { ArrowDownUp, Upload } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { PageLoader } from "@/components/PageLoader";
import { SelectionActionFooter } from "@/components/SelectionActionFooter";
import { StampToolFooter } from "@/components/StampToolFooter";
import { SyncBanner } from "@/components/SyncBanner";
import { TagFilterBar } from "@/components/TagFilterBar";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import { Button } from "@/components/ui/button";
import { useLibraryBootstrap } from "@/hooks/use-library-bootstrap";
import {
    SELECTION_FOOTER_INSET_PX,
    buildMediaGridSelection,
} from "@/lib/selection";
import {
    isSessionAuthenticated,
    reconcileSessionWithCore,
    useSessionStore,
} from "@/stores/session-store";
import { dedupeFilesById } from "@/lib/sync/merge-files";
import { reconcileShuffledIds } from "@/lib/shuffle-files";
import {
    countTagFilterClauses,
    filterFilesByTags,
    isTagFilterActive,
    patchFilteredFilesForTagTouch,
} from "@/lib/tags";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import {
    remapSortedFilesIfSameIds,
    sortFilesByEdit,
    sortFilesByUpload,
} from "@/lib/sort-files";
import { sortFilesByUpdatedAt } from "@/lib/updated-at-sort";
import {
    deviceViewerAspectRatio,
    sortFilesByViewportFit,
} from "@/lib/viewport-fit";
import { sortFilesByImageSize } from "@/lib/image-size-sort";
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
import { useSettingsStore } from "@/stores/settings-store";
import { useLibraryStore } from "@/stores/library-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";
import { useUIStore, useUploadJobStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";
import { toast } from "sonner";

/**
 * Keep a frozen id order; drop gone ids; append newcomers at the end.
 */
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

const PhotoViewer = dynamic(
    () =>
        import("@/components/PhotoViewer").then((mod) => ({
            default: mod.PhotoViewer,
        })),
    { ssr: false },
);

export default function GalleryPage(): JSX.Element {
    const router = useRouter();
    const email = useSessionStore((s) => s.email);

    const allFiles = useLibraryStore((s) => s.allFiles);
    const filesRevision = useLibraryStore((s) => s.filesRevision);
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    const tagFilter = useTagStore((s) => s.tagFilter);
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
    const updatedAtSort = useUIStore((s) => s.updatedAtSort);
    const imageSizeSort = useUIStore((s) => s.imageSizeSort);
    const tagFilterFitSort = useUIStore((s) => s.tagFilterFitSort);
    const relativeSort = useUIStore((s) => s.relativeSort);
    const relativeSeed = useUIStore((s) => s.relativeSeed);
    const relativeStartFileId = useUIStore((s) => s.relativeStartFileId);
    const nearnessFilter = useUIStore((s) => s.nearnessFilter);
    const nearnessEpoch = useUIStore((s) => s.nearnessEpoch);
    const setNearnessFilter = useUIStore((s) => s.setNearnessFilter);
    const setUploadPanelOpen = useUploadJobStore((s) => s.setPanelOpen);
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const initialLoadDone = useLibraryBootstrap();
    const gallerySortBy = useSettingsStore((s) => s.gallerySortBy);
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.hydrate);

    const nearnessActive =
        nearnessFilter !== undefined && isTagFilterActive(nearnessFilter);

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

    const [viewerAspect, setViewerAspect] = useState<number>(
        () => (typeof window === "undefined" ? 1 : deviceViewerAspectRatio()),
    );

    useEffect(() => {
        const updateAspect = (): void => {
            setViewerAspect(deviceViewerAspectRatio());
        };
        updateAspect();
        window.addEventListener("resize", updateAspect);
        window.visualViewport?.addEventListener("resize", updateAspect);
        return (): void => {
            window.removeEventListener("resize", updateAspect);
            window.visualViewport?.removeEventListener("resize", updateAspect);
        };
    }, []);

    // Drop a stale inactive filter object (e.g. empty after edits elsewhere).
    useEffect(() => {
        if (!nearnessFilter || isTagFilterActive(nearnessFilter)) {
            return;
        }
        setNearnessFilter(undefined);
    }, [nearnessFilter, setNearnessFilter]);

    // Nearness is gallery-session only — clear when leaving Media.
    useEffect(() => {
        return (): void => {
            useUIStore.getState().setNearnessFilter(undefined);
        };
    }, []);

    useEffect(() => {
        if (!nearnessActive || embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings, nearnessActive]);

    const sortLibraryFiles = useCallback(
        (files: EnteFile[]): EnteFile[] =>
            gallerySortBy === "edited" ?
                sortFilesByEdit(files) :
                sortFilesByUpload(files),
        [gallerySortBy],
    );

    /**
     * Nearness needs CLIP medoids from seed photos matching the nearness
     * filter. Embed missing seeds on demand, then reapply. Full-library CLIP
     * scan stays explicit (Manage → Settings).
     */
    useEffect(() => {
        if (!nearnessActive || !nearnessFilter || !embeddingHydrated || !initialLoadDone) {
            return;
        }
        let cancelled = false;
        const abort = new AbortController();

        void (async (): Promise<void> => {
            const userId = useSessionStore.getState().userID ?? 0;
            const library = sortLibraryFiles(
                dedupeFilesById(useLibraryStore.getState().allFiles).filter(
                    (file) => !isFileArchivedLocally(file),
                ),
            );
            const tagState = useTagStore.getState();
            const seedMatches = filterFilesByTags(
                library,
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
    }, [
        embeddingHydrated,
        initialLoadDone,
        nearnessActive,
        nearnessEpoch,
        nearnessFilter,
        sortLibraryFiles,
    ]);

    /**
     * Nearness order snapshotted at apply/reapply (epoch bump).
     * Reads library via getState so stamping does not rebuild.
     *
     * `orderIds` is the production competitive order, shown immediately.
     * `marginsInput` is set when the learned kit margins apply; the effect
     * below ranks them in a worker and swaps the order in once it lands.
     */
    const frozenNearness = useMemo((): {
        orderIds: number[];
        marginsInput?: KitMarginsRankingInput;
    } => {
        const filter = useUIStore.getState().nearnessFilter;
        if (!filter || !isTagFilterActive(filter) || !embeddingHydrated) {
            return { orderIds: [] };
        }
        const library = sortLibraryFiles(
            dedupeFilesById(useLibraryStore.getState().allFiles).filter(
                (file) => !isFileArchivedLocally(file),
            ),
        );
        const embeddings = useEmbeddingIndexStore.getState().entries;
        const tagState = useTagStore.getState();
        const favoriteIds = useFavoritesStore.getState().favoriteFileIds;
        const filterOptions = {
            favoriteFileIds: favoriteIds,
            includeInEffectsPresenceByName:
                tagState.includeInEffectsPresenceByName,
        };
        const seedIds = filterFilesByTags(
            library,
            filter,
            tagState.fileIdsByTag,
            filterOptions,
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
        const filtered = filterFilesByTags(
            library,
            tagState.tagFilter,
            tagState.fileIdsByTag,
            filterOptions,
        );
        // Rival penalties when nearness is exactly one kit. For Kit likeness,
        // respect the session toggle; Filter nearness always uses rivals.
        const ui = useUIStore.getState();
        const useRivalPenalty =
            matchedKit !== undefined &&
            (ui.nearnessSource !== "kit" || ui.kitLikenessRivalPenalty);
        const rivalMedoidSets = useRivalPenalty ?
            useTagSpeedStore
                .getState()
                .presets.filter((entry) => entry.id !== matchedKit.id)
                .map((entry) => {
                    if (!entry.tags.length) {
                        return [];
                    }
                    const rivalGenome =
                        entry.nearnessTune?.genome ??
                        DEFAULT_KIT_EMBEDDING_GENOME;
                    return buildKitEmbeddingPrototypes(
                        listKitSeedFiles(library, entry.tags).map(
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
                libraryFiles: library,
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
        // nearnessEpoch is the intentional rebuild trigger.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot only on apply
    }, [nearnessEpoch, nearnessFilter, embeddingHydrated, sortLibraryFiles]);

    /**
     * Learned kit margins ranked off the gallery thread; empty until the
     * worker answers (production order shows meanwhile) or when they do not
     * apply. Worker failure keeps the production order.
     */
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

    /**
     * Relative snake snapshotted when mode/seed changes (or embeddings hydrate).
     * Computed off the gallery thread so tagging / filter taps stay responsive.
     */
    const [frozenRelativeOrderIds, setFrozenRelativeOrderIds] = useState<
        number[]
    >([]);
    const relativeJobRef = useRef(0);

    useEffect(() => {
        if (relativeSort === "none" || !embeddingHydrated) {
            relativeJobRef.current += 1;
            setFrozenRelativeOrderIds([]);
            return;
        }
        const jobId = relativeJobRef.current + 1;
        relativeJobRef.current = jobId;

        const library = sortLibraryFiles(
            dedupeFilesById(useLibraryStore.getState().allFiles).filter(
                (file) => !isFileArchivedLocally(file),
            ),
        );
        const embeddings = useEmbeddingIndexStore.getState().entries;
        const tagState = useTagStore.getState();
        const favoriteIds = useFavoritesStore.getState().favoriteFileIds;
        const filtered = filterFilesByTags(
            library,
            tagState.tagFilter,
            tagState.fileIdsByTag,
            {
                favoriteFileIds: favoriteIds,
                includeInEffectsPresenceByName:
                    tagState.includeInEffectsPresenceByName,
            },
        );
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
            startTransition(() => {
                setFrozenRelativeOrderIds([...embeddedOrder, ...skipped]);
            });
        };

        if (withEmbeddingIds.length < 2) {
            applyOrder(filtered.map((file) => file.id));
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
                applyOrder(
                    sortFilesByRelative(
                        filtered,
                        relativeSort,
                        embeddings,
                        relativeSeed,
                        relativeStartFileId,
                    ).map((file) => file.id),
                );
            });
    }, [
        relativeSort,
        relativeSeed,
        relativeStartFileId,
        embeddingHydrated,
        sortLibraryFiles,
    ]);

    const libraryFilesCacheRef = useRef<EnteFile[]>([]);
    const librarySourceRef = useRef<EnteFile[] | undefined>(undefined);
    const librarySortFnRef = useRef(sortLibraryFiles);
    const libraryFiles = useMemo(() => {
        // filesRevision bumps on in-place slot swaps when allFiles identity is unchanged.
        void filesRevision;
        const prev = libraryFilesCacheRef.current;
        const sourceUnchanged = allFiles === librarySourceRef.current;
        const sortUnchanged = sortLibraryFiles === librarySortFnRef.current;
        librarySortFnRef.current = sortLibraryFiles;

        if (sourceUnchanged && sortUnchanged && prev.length > 0) {
            const remapped: EnteFile[] = [];
            const library = useLibraryStore.getState();
            for (const file of prev) {
                const updated = library.getFileById(file.id) ?? file;
                if (!isFileArchivedLocally(updated)) {
                    remapped.push(updated);
                }
            }
            libraryFilesCacheRef.current = remapped;
            return remapped;
        }

        librarySourceRef.current = allFiles;
        const deduped = dedupeFilesById(allFiles).filter(
            (file) => !isFileArchivedLocally(file),
        );
        if (sortUnchanged) {
            const remapped = remapSortedFilesIfSameIds(prev, deduped);
            if (remapped) {
                libraryFilesCacheRef.current = remapped;
                return remapped;
            }
        }
        const sorted = sortLibraryFiles(deduped);
        libraryFilesCacheRef.current = sorted;
        return sorted;
    }, [
        allFiles,
        filesRevision,
        sortLibraryFiles,
    ]);

    const filteredFilesCacheRef = useRef<EnteFile[]>([]);
    const filterBasisRef = useRef<{
        tagFilter: typeof tagFilter;
        favoriteFileIds: typeof favoriteFileIds;
        includeInEffectsPresenceByName: typeof includeInEffectsPresenceByName;
    } | undefined>(undefined);
    const filteredFiles = useMemo(() => {
        // tagIndexRevision forces refresh when fileIdsByTag Map identity alone is unreliable.
        void tagIndexRevision;
        if (!isTagFilterActive(tagFilter)) {
            filteredFilesCacheRef.current = libraryFiles;
            filterBasisRef.current = {
                tagFilter,
                favoriteFileIds,
                includeInEffectsPresenceByName,
            };
            return libraryFiles;
        }
        const options = {
            favoriteFileIds,
            includeInEffectsPresenceByName,
        };
        const basis = filterBasisRef.current;
        const filterUnchanged =
            basis?.tagFilter === tagFilter &&
            basis.favoriteFileIds === favoriteFileIds &&
            basis.includeInEffectsPresenceByName ===
                includeInEffectsPresenceByName;
        const touchIds = lastTagTouchFileIds;
        // Only splice one file when the filter basis is unchanged — otherwise
        // a stale lastTagTouch would patch against a new filter incorrectly.
        if (
            filterUnchanged &&
            touchIds?.length === 1 &&
            filteredFilesCacheRef.current.length
        ) {
            const patched = patchFilteredFilesForTagTouch(
                filteredFilesCacheRef.current,
                libraryFiles,
                touchIds[0]!,
                tagFilter,
                fileIdsByTag,
                options,
            );
            if (patched) {
                filteredFilesCacheRef.current = patched;
                return patched;
            }
        }
        const next = filterFilesByTags(
            libraryFiles,
            tagFilter,
            fileIdsByTag,
            options,
        );
        filteredFilesCacheRef.current = next;
        filterBasisRef.current = {
            tagFilter,
            favoriteFileIds,
            includeInEffectsPresenceByName,
        };
        return next;
    }, [
        libraryFiles,
        tagFilter,
        fileIdsByTag,
        favoriteFileIds,
        includeInEffectsPresenceByName,
        tagIndexRevision,
        lastTagTouchFileIds,
    ]);

    // Latch tag-fit mode across filter edits; only reorder while clauses exist.
    const tagFilterFitActive =
        tagFilterFitSort !== "none" &&
        countTagFilterClauses(tagFilter.root) > 0;
    const relativeActive = relativeSort !== "none";

    useEffect(() => {
        if (
            mediaViewOrder !== "shuffled" ||
            viewportFitSort !== "none" ||
            updatedAtSort !== "none" ||
            imageSizeSort !== "none" ||
            tagFilterFitActive ||
            relativeActive ||
            nearnessActive
        ) {
            return;
        }
        reconcileMediaShuffle(filteredFiles.map((file) => file.id));
    }, [
        filteredFiles,
        nearnessActive,
        mediaViewOrder,
        reconcileMediaShuffle,
        relativeActive,
        tagFilterFitActive,
        viewportFitSort,
        updatedAtSort,
        imageSizeSort,
    ]);

    const computedOrderCacheRef = useRef<{
        kind: string;
        tagFilter: typeof tagFilter;
        ids: number[];
    }>({ kind: "", tagFilter, ids: [] });

    const files = useMemo(() => {
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
        if (updatedAtSort !== "none") {
            return sortFilesByUpdatedAt(filteredFiles, updatedAtSort);
        }
        if (viewportFitSort !== "none") {
            return reuseComputedOrder(
                `viewport:${viewportFitSort}:${viewerAspect}`,
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
        return orderedIds.flatMap((id) => {
            const file = byId.get(id);
            return file ? [file] : [];
        });
    }, [
        embeddingHydrated,
        filteredFiles,
        frozenNearnessOrderIds,
        frozenRelativeOrderIds,
        imageSizeSort,
        nearnessActive,
        mediaShuffledFileIds,
        mediaShuffleSeed,
        mediaViewOrder,
        relativeActive,
        tagFilter,
        tagFilterFitActive,
        tagFilterFitSort,
        updatedAtSort,
        viewportFitSort,
        viewerAspect,
    ]);

    const matchCount = filteredFiles.length;

    const matchingFileIds = useMemo(
        () => filteredFiles.map((file) => file.id),
        [filteredFiles],
    );

    const [viewerFileId, setViewerFileId] = useState<number | undefined>();

    const selectionEnabled = useSelectionStore((s) => s.enabled);
    const selectedIds = useSelectionStore((s) => s.selectedIds);
    const toggleSelection = useSelectionStore((s) => s.toggle);
    const selectMany = useSelectionStore((s) => s.selectMany);
    const pruneToVisible = useSelectionStore((s) => s.pruneToVisible);
    const setSelectionEnabled = useSelectionStore((s) => s.setEnabled);
    const resetSelection = useSelectionStore((s) => s.reset);
    const stampActive = useSelectionStore((s) => s.stampActive);
    const stampTags = useSelectionStore((s) => s.stampTags);

    const visibleFileIds = useMemo(
        () => new Set(files.map((file) => file.id)),
        [files],
    );

    // Keep the selection while select mode is on — tag edits often drop files
    // out of the active filter, and pruning would wipe a multi-select mid-edit.
    useEffect(() => {
        if (selectionEnabled) {
            return;
        }
        pruneToVisible(visibleFileIds);
    }, [pruneToVisible, selectionEnabled, visibleFileIds]);

    // Selection is one edit session for the current filter. Sort can change;
    // filter changes end the session. Leave-gallery cleanup is the unmount reset.
    const selectionFilterRef = useRef(tagFilter);
    useEffect(() => {
        if (selectionFilterRef.current === tagFilter) {
            return;
        }
        selectionFilterRef.current = tagFilter;
        if (useSelectionStore.getState().enabled) {
            setSelectionEnabled(false);
        }
    }, [setSelectionEnabled, tagFilter]);

    useEffect(() => {
        return (): void => {
            resetSelection();
        };
    }, [resetSelection]);

    const gridSelection = useMemo(
        () =>
            buildMediaGridSelection({
                selectionEnabled,
                selectedIds,
                stampActive,
                stampTags,
                toggleSelection,
                selectMany,
            }),
        [
            selectMany,
            selectedIds,
            selectionEnabled,
            stampActive,
            stampTags,
            toggleSelection,
        ],
    );

    const footerInsetPx =
        stampActive || (selectionEnabled && selectedIds.length > 0) ?
            SELECTION_FOOTER_INSET_PX :
            0;

    useEffect(() => {
        reconcileSessionWithCore();
        if (!isSessionAuthenticated()) {
            void router.replace("/login");
        }
    }, [router]);

    const handleOpenFile = useCallback((file: EnteFile): void => {
        const { enabled, stampActive: stamping } = useSelectionStore.getState();
        if (enabled || stamping) {
            return;
        }
        setViewerFileId(file.id);
    }, []);

    const handleCloseViewer = useCallback((): void => {
        setViewerFileId(undefined);
    }, []);

    const handleFileUpdated = useCallback((file: EnteFile): void => {
        setViewerFileId((current) =>
            current === undefined ? undefined : file.id);
    }, []);

    const patchSettings = useSettingsStore((s) => s.patchSettings);

    const handleToggleSort = (): void => {
        patchSettings({
            gallerySortBy: gallerySortBy === "edited" ? "uploaded" : "edited",
        });
    };

    const showFullPageLoader: boolean =
        !initialLoadDone &&
        (syncStatus === "loadingFromCache" || syncStatus === "syncing") &&
        files.length === 0;

    if (!isSessionAuthenticated()) {
        return <PageLoader message="Redirecting to sign in…" />;
    }

    return (
        <AppShell
            title="Media"
            email={email}
            actions={
                <>
                    <Button
                        type="button"
                        variant={gallerySortBy === "edited" ? "secondary" : "outline"}
                        size="icon-sm"
                        aria-label={
                            gallerySortBy === "edited" ?
                                "Sort by upload date" :
                                "Sort by last edited"
                        }
                        aria-pressed={gallerySortBy === "edited"}
                        onClick={handleToggleSort}
                        title={
                            gallerySortBy === "edited" ?
                                "Sorting by edit time — tap to sort by upload" :
                                "Sorting by upload — tap to sort by edit"
                        }
                    >
                        <ArrowDownUp />
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label="Upload photos and videos"
                        onClick={() => setUploadPanelOpen(true)}
                    >
                        <Upload />
                    </Button>
                </>
            }
        >
            <SyncBanner />
            <TagFilterBar
                matchCount={matchCount}
                matchingFileIds={matchingFileIds}
            />

            {showFullPageLoader ? (
                <PageLoader message="Loading your library…" />
            ) : (
                <ThumbnailGrid
                    files={files}
                    onOpenFile={
                        selectionEnabled || stampActive ?
                            undefined :
                            handleOpenFile
                    }
                    selection={gridSelection}
                    footerInsetPx={footerInsetPx}
                />
            )}

            <SelectionActionFooter />
            <StampToolFooter />

            {viewerFileId !== undefined ? (
                <PhotoViewer
                    files={files}
                    initialFileId={viewerFileId}
                    onClose={handleCloseViewer}
                    onFileUpdated={handleFileUpdated}
                />
            ) : null}
        </AppShell>
    );
}
