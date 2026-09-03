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
import { SyncBanner } from "@/components/SyncBanner";
import { TagFilterBar } from "@/components/TagFilterBar";
import {
    ThumbnailGrid,
    type ThumbnailGridSelection,
} from "@/components/ThumbnailGrid";
import { Button } from "@/components/ui/button";
import { useLibraryBootstrap } from "@/hooks/use-library-bootstrap";
import { SELECTION_FOOTER_INSET_PX } from "@/lib/selection";
import { bulkAddTags } from "@/lib/tag-bulk-actions";
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
import { useSettingsStore } from "@/stores/settings-store";
import { useLibraryStore } from "@/stores/library-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagStore } from "@/stores/tag-store";
import { useUIStore, useUploadJobStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";

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
    const setUploadPanelOpen = useUploadJobStore((s) => s.setPanelOpen);
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const initialLoadDone = useLibraryBootstrap();
    const gallerySortBy = useSettingsStore((s) => s.gallerySortBy);

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

    const sortLibraryFiles = useCallback(
        (files: EnteFile[]): EnteFile[] =>
            gallerySortBy === "edited" ?
                sortFilesByEdit(files) :
                sortFilesByUpload(files),
        [gallerySortBy],
    );

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
        if (mediaViewOrder !== "shuffled" || viewportFitSort !== "none") {
            return;
        }
        reconcileMediaShuffle(filteredFiles.map((file) => file.id));
    }, [filteredFiles, mediaViewOrder, reconcileMediaShuffle, viewportFitSort]);

    const files = useMemo(() => {
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

    const gridSelection = useMemo((): ThumbnailGridSelection | undefined => {
        if (!selectionEnabled) {
            return undefined;
        }
        if (stampActive && stampTags.length > 0) {
            return {
                selectedIds: new Set(selectedIds),
                onToggle: (file) => {
                    toggleSelection(file.id);
                    void bulkAddTags([file.id], stampTags);
                },
                onSelectMany: (fileIds, mode) => {
                    selectMany(fileIds, mode);
                    if (mode === "add") {
                        void bulkAddTags(fileIds, stampTags);
                    }
                },
            };
        }
        return {
            selectedIds: new Set(selectedIds),
            onToggle: (file) => toggleSelection(file.id),
            onSelectMany: selectMany,
        };
    }, [
        selectionEnabled,
        selectedIds,
        selectMany,
        stampActive,
        stampTags,
        toggleSelection,
    ]);

    const footerInsetPx =
        selectionEnabled && (selectedIds.length > 0 || stampActive) ?
            SELECTION_FOOTER_INSET_PX :
            0;

    useEffect(() => {
        reconcileSessionWithCore();
        if (!isSessionAuthenticated()) {
            void router.replace("/login");
        }
    }, [router]);

    const handleOpenFile = useCallback((file: EnteFile): void => {
        if (useSelectionStore.getState().enabled) {
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
                    onOpenFile={selectionEnabled ? undefined : handleOpenFile}
                    selection={gridSelection}
                    footerInsetPx={footerInsetPx}
                />
            )}

            <SelectionActionFooter />

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
