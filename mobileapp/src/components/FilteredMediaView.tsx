import dynamic from "next/dynamic";
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type JSX,
} from "react";
import { PageLoader } from "@/components/PageLoader";
import {
    ThumbnailGrid,
    type ThumbnailGridSelection,
} from "@/components/ThumbnailGrid";
import { SELECTION_FOOTER_INSET_PX } from "@/lib/selection";
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
    const toggleSelection = useSelectionStore((s) => s.toggle);
    const selectMany = useSelectionStore((s) => s.selectMany);
    const pruneToVisible = useSelectionStore((s) => s.pruneToVisible);

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

    useEffect(() => {
        pruneToVisible(visibleFileIds);
    }, [pruneToVisible, visibleFileIds]);

    const gridSelection = useMemo((): ThumbnailGridSelection | undefined => {
        if (!selectionEnabled) {
            return undefined;
        }
        return {
            selectedIds: new Set(selectedIds),
            onToggle: (file) => toggleSelection(file.id),
            onSelectMany: selectMany,
        };
    }, [selectionEnabled, selectedIds, selectMany, toggleSelection]);

    const footerInsetPx =
        selectionEnabled && selectedIds.length > 0 ?
            SELECTION_FOOTER_INSET_PX :
            0;

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

    if (loading && files.length === 0) {
        return <PageLoader message={loadingMessage} />;
    }

    return (
        <>
            <ThumbnailGrid
                files={displayFiles}
                onOpenFile={selectionEnabled ? undefined : handleOpenFile}
                selection={gridSelection}
                footerInsetPx={footerInsetPx}
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
        </>
    );
}
