import {
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
import { RotateToolFooter } from "@/components/RotateToolFooter";
import { SyncBanner } from "@/components/SyncBanner";
import { TagFilterBar } from "@/components/TagFilterBar";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import { Button } from "@/components/ui/button";
import { useLibraryBootstrap } from "@/hooks/use-library-bootstrap";
import { useMediaDisplayPipeline } from "@/hooks/use-media-display-pipeline";
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
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import {
    remapSortedFilesIfSameIds,
    sortFilesByEdit,
    sortFilesByUpload,
} from "@/lib/sort-files";
import { useSettingsStore } from "@/stores/settings-store";
import { useLibraryStore } from "@/stores/library-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagStore } from "@/stores/tag-store";
import { useUploadJobStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";

/** Stable empty set so gallery can skip favourite-store updates when unused. */
const EMPTY_FAVORITE_FILE_IDS = new Set<number>();

const PhotoViewer = dynamic(
    () =>
        import("@/components/PhotoViewer").then((mod) => ({
            default: mod.PhotoViewer,
        })),
    { ssr: false },
);

const formatPhotoCount = (count: number): string =>
    count.toLocaleString();

/**
 * Light Media route shell — paints AppShell + prepare loader before the heavy
 * filter/sort/grid subtree mounts (see {@link GalleryMediaBody}).
 */
export default function GalleryPage(): JSX.Element {
    const router = useRouter();
    const email = useSessionStore((s) => s.email);
    const libraryFileCount = useLibraryStore((s) => s.allFiles.length);
    const setUploadPanelOpen = useUploadJobStore((s) => s.setPanelOpen);
    const gallerySortBy = useSettingsStore((s) => s.gallerySortBy);
    const patchSettings = useSettingsStore((s) => s.patchSettings);
    const [bodyMounted, setBodyMounted] = useState(false);

    useEffect(() => {
        reconcileSessionWithCore();
        if (!isSessionAuthenticated()) {
            void router.replace("/login");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only auth gate
    }, []);

    useEffect(() => {
        let cancelled = false;
        const id = requestAnimationFrame(() => {
            if (!cancelled) {
                setBodyMounted(true);
            }
        });
        return (): void => {
            cancelled = true;
            cancelAnimationFrame(id);
        };
    }, []);

    const handleToggleSort = (): void => {
        patchSettings({
            gallerySortBy: gallerySortBy === "edited" ? "uploaded" : "edited",
        });
    };

    if (!isSessionAuthenticated()) {
        return <PageLoader message="Redirecting to sign in…" />;
    }

    return (
        <AppShell
            title="Media"
            email={email}
            mainScrolls={false}
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
            {bodyMounted ? (
                <GalleryMediaBody />
            ) : (
                <PageLoader
                    message="Preparing media…"
                    detail={
                        libraryFileCount > 0 ?
                            `0 of ${formatPhotoCount(libraryFileCount)} photos` :
                            undefined
                    }
                    progress={
                        libraryFileCount > 0 ?
                            { current: 0, total: libraryFileCount } :
                            undefined
                    }
                />
            )}
        </AppShell>
    );
}

/**
 * Heavy gallery body — filter pipeline, grid, selection footers, viewer.
 * Mounted only after the Media shell's first paint.
 */
function GalleryMediaBody(): JSX.Element {
    const allFiles = useLibraryStore((s) => s.allFiles);
    const filesRevision = useLibraryStore((s) => s.filesRevision);
    const tagFilter = useTagStore((s) => s.tagFilter);
    const favoritesScopeActive = tagFilter.favoritesScope !== "all";
    const favoriteFileIds = useFavoritesStore((s) =>
        favoritesScopeActive ? s.favoriteFileIds : EMPTY_FAVORITE_FILE_IDS);
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const initialLoadDone = useLibraryBootstrap();
    const gallerySortBy = useSettingsStore((s) => s.gallerySortBy);

    const sortLibraryFiles = useCallback(
        (files: EnteFile[]): EnteFile[] =>
            gallerySortBy === "edited" ?
                sortFilesByEdit(files) :
                sortFilesByUpload(files),
        [gallerySortBy],
    );

    const libraryFilesCacheRef = useRef<EnteFile[]>([]);
    const librarySourceRef = useRef<EnteFile[] | undefined>(undefined);
    const librarySortFnRef = useRef(sortLibraryFiles);
    const libraryFiles = useMemo(() => {
        void filesRevision;
        const prev = libraryFilesCacheRef.current;
        const sourceUnchanged = allFiles === librarySourceRef.current;
        const sortUnchanged = sortLibraryFiles === librarySortFnRef.current;
        librarySortFnRef.current = sortLibraryFiles;

        if (sourceUnchanged && sortUnchanged && prev.length > 0) {
            const remapped: EnteFile[] = [];
            const library = useLibraryStore.getState();
            let changed = false;
            for (const file of prev) {
                const updated = library.getFileById(file.id) ?? file;
                if (isFileArchivedLocally(updated)) {
                    changed = true;
                    continue;
                }
                if (updated !== file) {
                    changed = true;
                }
                remapped.push(updated);
            }
            if (!changed) {
                return prev;
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
    }, [allFiles, filesRevision, sortLibraryFiles]);

    const { filteredFiles, displayFiles, matchCount } = useMediaDisplayPipeline({
        libraryFiles,
        tagFilter,
        favoriteFileIds,
        initialLoadDone,
        clearNearnessOnUnmount: true,
    });

    const [viewerFileId, setViewerFileId] = useState<number | undefined>();
    const viewerFilesRef = useRef(displayFiles);
    if (viewerFileId === undefined) {
        viewerFilesRef.current = displayFiles;
    }

    const selectionEnabled = useSelectionStore((s) => s.enabled);
    const selectedIds = useSelectionStore((s) => s.selectedIds);
    const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
    const toggleSelection = useSelectionStore((s) => s.toggle);
    const selectMany = useSelectionStore((s) => s.selectMany);
    const pruneToVisible = useSelectionStore((s) => s.pruneToVisible);
    const setSelectionEnabled = useSelectionStore((s) => s.setEnabled);
    const resetSelection = useSelectionStore((s) => s.reset);
    const stampActive = useSelectionStore((s) => s.stampActive);
    const stampTags = useSelectionStore((s) => s.stampTags);
    const rotateActive = useSelectionStore((s) => s.rotateActive);
    const pendingRotations = useSelectionStore((s) => s.pendingRotations);
    const bumpRotate = useSelectionStore((s) => s.bumpRotate);
    const rotateBusy = useSelectionStore((s) => s.rotateBusy);

    useEffect(() => {
        if (selectionEnabled) {
            return;
        }
        pruneToVisible(new Set(displayFiles.map((file) => file.id)));
    }, [displayFiles, pruneToVisible, selectionEnabled]);

    const selectionFilterRef = useRef(tagFilter);
    useEffect(() => {
        if (selectionFilterRef.current === tagFilter) {
            return;
        }
        selectionFilterRef.current = tagFilter;
        const state = useSelectionStore.getState();
        if (state.enabled) {
            setSelectionEnabled(false);
        }
        if (state.rotateActive) {
            state.setRotateActive(false);
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
                selectedIds: selectedIdSet,
                stampActive,
                stampTags,
                rotateActive,
                bumpRotate,
                toggleSelection,
                selectMany,
                disabled: rotateBusy,
            }),
        [
            bumpRotate,
            rotateActive,
            rotateBusy,
            selectMany,
            selectedIdSet,
            selectionEnabled,
            stampActive,
            stampTags,
            toggleSelection,
        ],
    );

    const footerInsetPx =
        stampActive || rotateActive || selectionEnabled ?
            SELECTION_FOOTER_INSET_PX :
            0;

    const handleOpenFile = useCallback((file: EnteFile): void => {
        const {
            enabled,
            stampActive: stamping,
            rotateActive: rotating,
        } = useSelectionStore.getState();
        if (enabled || stamping || rotating) {
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

    const showFullPageLoader: boolean =
        !initialLoadDone &&
        (syncStatus === "loadingFromCache" || syncStatus === "syncing") &&
        displayFiles.length === 0;

    return (
        <>
            <TagFilterBar
                matchCount={matchCount}
                matchingFiles={filteredFiles}
            />

            {showFullPageLoader ? (
                <PageLoader message="Loading your library…" />
            ) : (
                <ThumbnailGrid
                    files={displayFiles}
                    onOpenFile={
                        selectionEnabled || stampActive || rotateActive ?
                            undefined :
                            handleOpenFile
                    }
                    selection={gridSelection}
                    footerInsetPx={footerInsetPx}
                    previewRotationById={
                        rotateActive ? pendingRotations : undefined
                    }
                />
            )}

            <SelectionActionFooter />
            <StampToolFooter />
            <RotateToolFooter />

            {viewerFileId !== undefined ? (
                <PhotoViewer
                    files={viewerFilesRef.current}
                    initialFileId={viewerFileId}
                    onClose={handleCloseViewer}
                    onFileUpdated={handleFileUpdated}
                />
            ) : null}
        </>
    );
}
