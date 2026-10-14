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

    const selectionEnabled = useSelectionStore((s) => s.enabled);
    const pruneToVisible = useSelectionStore((s) => s.pruneToVisible);
    const stampActive = useSelectionStore((s) => s.stampActive);
    const rotateActive = useSelectionStore((s) => s.rotateActive);
    const pendingRotations = useSelectionStore((s) => s.pendingRotations);
    const rotateBusy = useSelectionStore((s) => s.rotateBusy);
    const cropActive = useSelectionStore((s) => s.cropActive);
    const cropBusy = useSelectionStore((s) => s.cropBusy);

    const visibleFileIds = useMemo(
        () => new Set(files.map((file) => file.id)),
        [files],
    );

    useEffect(() => {
        pruneToVisible(visibleFileIds);
    }, [pruneToVisible, visibleFileIds]);

    const gridSelection = useMediaGridSelection({
        disabled: rotateBusy || cropBusy,
    });

    const toolActive =
        selectionEnabled || stampActive || rotateActive || cropActive;
    const footerInsetPx = toolActive ? SELECTION_FOOTER_INSET_PX : 0;

    const handleOpenFile = useCallback((file: EnteFile): void => {
        const {
            enabled,
            stampActive: stamping,
            rotateActive: rotating,
            cropActive: cropping,
        } = useSelectionStore.getState();
        if (enabled || stamping || rotating || cropping) {
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
                files={files}
                onOpenFile={toolActive ? undefined : handleOpenFile}
                selection={gridSelection}
                footerInsetPx={footerInsetPx}
                previewRotationById={
                    rotateActive ? pendingRotations : undefined
                }
            />
            {viewerFileId !== undefined ? (
                <PhotoViewer
                    files={files}
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
