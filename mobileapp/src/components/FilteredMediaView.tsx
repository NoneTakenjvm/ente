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
import { useMediaGridSelection } from "@/hooks/use-media-grid-selection";
import { SELECTION_FOOTER_INSET_PX } from "@/lib/selection";
import { useSelectionStore } from "@/stores/selection-store";
import type { EnteFile } from "ente-media/file";

const PhotoViewer = dynamic(
    () =>
        import("@/components/PhotoViewer").then((mod) => ({
            default: mod.PhotoViewer,
        })),
    { ssr: false },
);

interface FilteredMediaViewProps {
    files: EnteFile[];
    loading?: boolean;
    loadingMessage?: string;
    albumCoverFileId?: number;
    onSetAlbumCover?: (fileId: number) => void;
}

/**
 * Thumbnail grid with photo viewer. Sort and shuffle are applied by the parent.
 */
export function FilteredMediaView({
    files,
    loading = false,
    loadingMessage = "Loading your library…",
    albumCoverFileId,
    onSetAlbumCover,
}: FilteredMediaViewProps): JSX.Element {
    const [viewerFileId, setViewerFileId] = useState<number | undefined>();

    const mode = useSelectionStore((s) => s.mode);
    const pruneToVisible = useSelectionStore((s) => s.pruneToVisible);
    const pendingRotations = useSelectionStore((s) => s.pendingRotations);
    const applyBusy = useSelectionStore((s) => s.applyBusy);

    const visibleFileIds = useMemo(
        () => new Set(files.map((file) => file.id)),
        [files],
    );

    useEffect(() => {
        pruneToVisible(visibleFileIds);
    }, [pruneToVisible, visibleFileIds]);

    const gridSelection = useMediaGridSelection({ disabled: applyBusy });

    const toolActive = mode !== "none";
    const footerInsetPx = toolActive ? SELECTION_FOOTER_INSET_PX : 0;

    const handleOpenFile = useCallback((file: EnteFile): void => {
        if (useSelectionStore.getState().mode !== "none") {
            return;
        }
        setViewerFileId(file.id);
    }, []);

    const handleCloseViewer = useCallback((): void => {
        setViewerFileId(undefined);
    }, []);

    if (loading && files.length === 0) {
        return <PageLoader message={loadingMessage} />;
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <ThumbnailGrid
                files={files}
                onOpenFile={toolActive ? undefined : handleOpenFile}
                selection={gridSelection}
                footerInsetPx={footerInsetPx}
                previewRotationById={
                    mode === "rotate" ? pendingRotations : undefined
                }
            />
            {viewerFileId !== undefined ? (
                <PhotoViewer
                    files={files}
                    initialFileId={viewerFileId}
                    onClose={handleCloseViewer}
                    albumCoverFileId={albumCoverFileId}
                    onSetAlbumCover={onSetAlbumCover}
                />
            ) : null}
        </div>
    );
}
