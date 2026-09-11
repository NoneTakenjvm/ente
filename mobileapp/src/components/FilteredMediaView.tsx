import dynamic from "next/dynamic";
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type JSX,
} from "react";
import { PageLoader } from "@/components/PageLoader";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import {
    SELECTION_FOOTER_INSET_PX,
    buildMediaGridSelection,
} from "@/lib/selection";
import { reconcileShuffledIds } from "@/lib/shuffle-files";
import { useSelectionStore } from "@/stores/selection-store";
import type { EnteFile } from "ente-media/file";

const PhotoViewer = dynamic(
    () =>
        import("@/components/PhotoViewer").then((mod) => ({
            default: mod.PhotoViewer,
        })),
    { ssr: false },
);

export type MediaViewOrder = "default" | "shuffled";

interface FilteredMediaViewProps {
    files: EnteFile[];
    loading?: boolean;
    loadingMessage?: string;
    viewOrder?: MediaViewOrder;
    shuffleSeed?: number;
    albumCoverFileId?: number;
    onSetAlbumCover?: (fileId: number) => void;
}

/**
 * Thumbnail grid with photo viewer. Shuffle controls live in the parent header.
 */
export function FilteredMediaView({
    files,
    loading = false,
    loadingMessage = "Loading your library…",
    viewOrder = "default",
    shuffleSeed = 0,
    albumCoverFileId,
    onSetAlbumCover,
}: FilteredMediaViewProps): JSX.Element {
    const [viewerFileId, setViewerFileId] = useState<number | undefined>();
    const [shuffledFileIds, setShuffledFileIds] = useState<number[]>([]);
    const [shuffleSnapshot, setShuffleSnapshot] = useState<{
        viewOrder: MediaViewOrder;
        shuffleSeed: number;
        fileIds: number[];
    }>({
        viewOrder,
        shuffleSeed,
        fileIds: files.map((file) => file.id),
    });

    const selectionEnabled = useSelectionStore((s) => s.enabled);
    const selectedIds = useSelectionStore((s) => s.selectedIds);
    const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
    const toggleSelection = useSelectionStore((s) => s.toggle);
    const selectMany = useSelectionStore((s) => s.selectMany);
    const pruneToVisible = useSelectionStore((s) => s.pruneToVisible);
    const stampActive = useSelectionStore((s) => s.stampActive);
    const stampTags = useSelectionStore((s) => s.stampTags);
    const rotateActive = useSelectionStore((s) => s.rotateActive);
    const pendingRotations = useSelectionStore((s) => s.pendingRotations);
    const bumpRotate = useSelectionStore((s) => s.bumpRotate);
    const rotateBusy = useSelectionStore((s) => s.rotateBusy);

    const fileIds = useMemo(
        () => files.map((file) => file.id),
        [files],
    );
    const fileIdsKey = fileIds.join(",");

    if (
        viewOrder !== shuffleSnapshot.viewOrder ||
        shuffleSeed !== shuffleSnapshot.shuffleSeed ||
        fileIdsKey !== shuffleSnapshot.fileIds.join(",")
    ) {
        const seedChanged =
            shuffleSeed !== shuffleSnapshot.shuffleSeed ||
            viewOrder !== shuffleSnapshot.viewOrder;
        const nextIds =
            viewOrder === "shuffled" ?
                reconcileShuffledIds(
                    fileIds,
                    shuffleSeed,
                    seedChanged || shuffledFileIds.length === 0 ?
                        undefined :
                        shuffledFileIds,
                ) :
                [];
        setShuffleSnapshot({ viewOrder, shuffleSeed, fileIds });
        if (
            nextIds.length !== shuffledFileIds.length ||
            nextIds.some((id, index) => id !== shuffledFileIds[index])
        ) {
            setShuffledFileIds(nextIds);
        }
    }

    const displayFiles = useMemo(() => {
        if (viewOrder !== "shuffled") {
            return files;
        }
        const byId = new Map(files.map((file) => [file.id, file]));
        return shuffledFileIds.flatMap((id) => {
            const file = byId.get(id);
            return file ? [file] : [];
        });
    }, [files, shuffledFileIds, viewOrder]);

    const visibleFileIds = useMemo(
        () => new Set(displayFiles.map((file) => file.id)),
        [displayFiles],
    );

    // Keep the selection while select mode is on — tag edits often drop files
    // out of the active filter, and pruning would wipe a multi-select mid-edit.
    useEffect(() => {
        if (selectionEnabled) {
            return;
        }
        pruneToVisible(visibleFileIds);
    }, [pruneToVisible, selectionEnabled, visibleFileIds]);

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

    if (loading && files.length === 0) {
        return <PageLoader message={loadingMessage} />;
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
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
            {viewerFileId !== undefined ? (
                <PhotoViewer
                    files={displayFiles}
                    initialFileId={viewerFileId}
                    onClose={handleCloseViewer}
                    onFileUpdated={handleFileUpdated}
                    albumCoverFileId={albumCoverFileId}
                    onSetAlbumCover={onSetAlbumCover}
                />
            ) : null}
        </div>
    );
}
