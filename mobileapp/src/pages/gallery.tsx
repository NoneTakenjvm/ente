import {
    useCallback,
    useEffect,
    useMemo,
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
    countFilesMatchingTagFilter,
    filterFilesByTags,
} from "@/lib/tags";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import { sortFilesByEdit, sortFilesByUpload } from "@/lib/sort-files";
import {
    deviceViewerAspectRatio,
    sortFilesByViewportFit,
} from "@/lib/viewport-fit";
import { sortFilesByImageSize } from "@/lib/image-size-sort";
import {
    buildKitEmbeddingCentroid,
    listKitSeedFiles,
    sortFilesByKitEmbeddingCompetitive,
} from "@/lib/kit-nearness-sort";
import { filterKitNearnessTags } from "@/lib/tag-types";
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
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    const tagFilter = useTagStore((s) => s.tagFilter);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const mediaViewOrder = useUIStore((s) => s.mediaViewOrder);
    const mediaShuffleSeed = useUIStore((s) => s.mediaShuffleSeed);
    const mediaShuffledFileIds = useUIStore((s) => s.mediaShuffledFileIds);
    const reconcileMediaShuffle = useUIStore((s) => s.reconcileMediaShuffle);
    const viewportFitSort = useUIStore((s) => s.viewportFitSort);
    const imageSizeSort = useUIStore((s) => s.imageSizeSort);
    const kitNearnessPresetId = useUIStore((s) => s.kitNearnessPresetId);
    const kitNearnessEpoch = useUIStore((s) => s.kitNearnessEpoch);
    const setKitNearnessPresetId = useUIStore((s) => s.setKitNearnessPresetId);
    const setUploadPanelOpen = useUploadJobStore((s) => s.setPanelOpen);
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const initialLoadDone = useLibraryBootstrap();
    const gallerySortBy = useSettingsStore((s) => s.gallerySortBy);
    const tagPresets = useTagSpeedStore((s) => s.presets);
    const includeInKitNearnessByName = useTagStore(
        (s) => s.includeInKitNearnessByName,
    );
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.hydrate);

    const kitNearnessPreset = useMemo(() => {
        if (!kitNearnessPresetId) {
            return undefined;
        }
        return tagPresets.find((preset) => preset.id === kitNearnessPresetId);
    }, [kitNearnessPresetId, tagPresets]);

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

    useEffect(() => {
        if (!kitNearnessPresetId || kitNearnessPreset) {
            return;
        }
        setKitNearnessPresetId(undefined);
    }, [kitNearnessPreset, kitNearnessPresetId, setKitNearnessPresetId]);

    // Kit nearness is gallery-session only — clear when leaving Media.
    useEffect(() => {
        return (): void => {
            useUIStore.getState().setKitNearnessPresetId(undefined);
        };
    }, []);

    useEffect(() => {
        if (!kitNearnessPreset || embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings, kitNearnessPreset]);

    const sortLibraryFiles = useCallback(
        (files: EnteFile[]): EnteFile[] =>
            gallerySortBy === "edited" ?
                sortFilesByEdit(files) :
                sortFilesByUpload(files),
        [gallerySortBy],
    );

    /**
     * Kit nearness needs CLIP centroids from seed photos. If seeds were never
     * embedded, embed them here (same idea as the old dHash seed hash) — then
     * reapply. Full-library CLIP scan is explicit only (Manage → Settings);
     * there is no background library scan.
     */
    useEffect(() => {
        if (!kitNearnessPreset || !embeddingHydrated || !initialLoadDone) {
            return;
        }
        let cancelled = false;
        const abort = new AbortController();
        const presetTags = filterKitNearnessTags(
            kitNearnessPreset.tags,
            includeInKitNearnessByName,
        );
        if (!presetTags.length) {
            toast.message(
                "This kit has no tags enabled for kit nearness. Enable them in Manage → Tags.",
            );
            setKitNearnessPresetId(undefined);
            return;
        }

        void (async (): Promise<void> => {
            const userId = useSessionStore.getState().userID ?? 0;
            const library = sortLibraryFiles(
                dedupeFilesById(useLibraryStore.getState().allFiles).filter(
                    (file) => !isFileArchivedLocally(file),
                ),
            );
            const seeds = imageFilesForPhash(
                listKitSeedFiles(library, presetTags),
                userId,
            );
            if (seeds.length === 0) {
                toast.message(
                    "No photos fully match this kit. Tag photos with every kit tag first.",
                );
                return;
            }

            let entries = useEmbeddingIndexStore.getState().entries;
            const missingSeeds = seeds.filter((file) => !entries.has(file.id));
            if (missingSeeds.length > 0) {
                const toastId = toast.loading(
                    `Embedding ${missingSeeds.length} kit photo${missingSeeds.length === 1 ? "" : "s"}…`,
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
                                "Could not embed kit photos",
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
                useUIStore.getState().reapplyKitNearness();
                return;
            }

            if (
                !buildKitEmbeddingCentroid(
                    seeds.map((file) => file.id),
                    entries,
                )
            ) {
                toast.message(
                    "Could not build kit nearness. Run Manage → Settings → Scan CLIP embeddings.",
                );
            }
        })();

        return (): void => {
            cancelled = true;
            abort.abort();
        };
    }, [
        embeddingHydrated,
        includeInKitNearnessByName,
        initialLoadDone,
        kitNearnessEpoch,
        kitNearnessPreset,
        setKitNearnessPresetId,
        sortLibraryFiles,
    ]);

    /**
     * Kit nearness order snapshotted at apply/reapply (epoch bump).
     * Reads library via getState so stamping does not rebuild.
     */
    const frozenKitOrderIds = useMemo((): number[] => {
        if (!kitNearnessPresetId || !embeddingHydrated) {
            return [];
        }
        const preset = useTagSpeedStore
            .getState()
            .presets.find((entry) => entry.id === kitNearnessPresetId);
        const includeMap =
            useTagStore.getState().includeInKitNearnessByName;
        const selectedTags = preset ?
            filterKitNearnessTags(preset.tags, includeMap) :
            [];
        if (!selectedTags.length) {
            return [];
        }
        const library = sortLibraryFiles(
            dedupeFilesById(useLibraryStore.getState().allFiles).filter(
                (file) => !isFileArchivedLocally(file),
            ),
        );
        const embeddings = useEmbeddingIndexStore.getState().entries;
        const allPresets = useTagSpeedStore.getState().presets;
        const selectedCentroid = buildKitEmbeddingCentroid(
            listKitSeedFiles(library, selectedTags).map((file) => file.id),
            embeddings,
        );
        if (!selectedCentroid) {
            return [];
        }
        const rivalCentroids = allPresets
            .filter((entry) => entry.id !== preset!.id)
            .map((entry) => {
                const rivalTags = filterKitNearnessTags(
                    entry.tags,
                    includeMap,
                );
                if (!rivalTags.length) {
                    return undefined;
                }
                return buildKitEmbeddingCentroid(
                    listKitSeedFiles(library, rivalTags).map(
                        (file) => file.id,
                    ),
                    embeddings,
                );
            })
            .filter((centroid): centroid is number[] => !!centroid?.length);
        const tagState = useTagStore.getState();
        const filtered = filterFilesByTags(
            library,
            tagState.tagFilter,
            tagState.fileIdsByTag,
            { favoriteFileIds: useFavoritesStore.getState().favoriteFileIds },
        );
        return sortFilesByKitEmbeddingCompetitive(
            filtered,
            selectedCentroid,
            rivalCentroids,
            embeddings,
        ).map((file) => file.id);
        // kitNearnessEpoch is the intentional rebuild trigger.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot only on apply
    }, [
        kitNearnessEpoch,
        kitNearnessPresetId,
        embeddingHydrated,
        sortLibraryFiles,
    ]);

    const libraryFiles = useMemo(() => {
        const deduped = dedupeFilesById(allFiles).filter(
            (file) => !isFileArchivedLocally(file),
        );
        return sortLibraryFiles(deduped);
    }, [allFiles, sortLibraryFiles]);

    const filteredFiles = useMemo(
        () =>
            filterFilesByTags(
                libraryFiles,
                tagFilter,
                fileIdsByTag,
                { favoriteFileIds },
            ),
        [libraryFiles, tagFilter, fileIdsByTag, favoriteFileIds],
    );

    useEffect(() => {
        if (
            mediaViewOrder !== "shuffled" ||
            viewportFitSort !== "none" ||
            imageSizeSort !== "none" ||
            kitNearnessPresetId !== undefined
        ) {
            return;
        }
        reconcileMediaShuffle(filteredFiles.map((file) => file.id));
    }, [
        filteredFiles,
        kitNearnessPresetId,
        mediaViewOrder,
        reconcileMediaShuffle,
        viewportFitSort,
        imageSizeSort,
    ]);

    const files = useMemo(() => {
        if (kitNearnessPreset) {
            return reconcileFrozenFileOrder(filteredFiles, frozenKitOrderIds);
        }
        if (imageSizeSort !== "none") {
            return sortFilesByImageSize(filteredFiles, imageSizeSort);
        }
        if (viewportFitSort !== "none") {
            return sortFilesByViewportFit(
                filteredFiles,
                viewportFitSort,
                viewerAspect,
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
        filteredFiles,
        frozenKitOrderIds,
        imageSizeSort,
        kitNearnessPreset,
        mediaShuffledFileIds,
        mediaShuffleSeed,
        mediaViewOrder,
        viewportFitSort,
        viewerAspect,
    ]);

    const matchCount = useMemo(() => {
        const candidateIds = new Set(libraryFiles.map((file) => file.id));
        return countFilesMatchingTagFilter(
            candidateIds,
            tagFilter,
            fileIdsByTag,
            libraryFiles,
            { favoriteFileIds },
        );
    }, [libraryFiles, tagFilter, fileIdsByTag, favoriteFileIds]);

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
    const resetSelection = useSelectionStore((s) => s.reset);
    const stampActive = useSelectionStore((s) => s.stampActive);
    const stampTags = useSelectionStore((s) => s.stampTags);

    const visibleFileIds = useMemo(
        () => new Set(files.map((file) => file.id)),
        [files],
    );

    useEffect(() => {
        pruneToVisible(visibleFileIds);
    }, [pruneToVisible, visibleFileIds]);

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
