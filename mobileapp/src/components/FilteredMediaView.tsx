import dynamic from "next/dynamic";
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type JSX,
} from "react";
import { CropToolFooter } from "@/components/CropToolFooter";
import { PageLoader } from "@/components/PageLoader";
import { RotateToolFooter } from "@/components/RotateToolFooter";
import { SelectionActionFooter } from "@/components/SelectionActionFooter";
import { StampToolFooter } from "@/components/StampToolFooter";
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
 * Thumbnail grid with photo viewer and selection tool footers. Sort and
 * shuffle are applied by the parent. The viewer keeps the list it was opened
 * with; selection resets when the view unmounts.
 */
export function FilteredMediaView({
    files,
    loading = false,
    loadingMessage = "Loading your library…",
    albumCoverFileId,
    onSetAlbumCover,
}: FilteredMediaViewProps): JSX.Element {
    const [viewer, setViewer] = useState<
        { fileId: number; files: EnteFile[] } | undefined
    >();

    const mode = useSelectionStore((s) => s.mode);
    const pruneToVisible = useSelectionStore((s) => s.pruneToVisible);
    const pendingRotations = useSelectionStore((s) => s.pendingRotations);

    const resetSelection = useSelectionStore((s) => s.reset);

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

    const gridSelection = useMediaGridSelection();

    const toolActive = mode !== "none";
    const footerInsetPx = toolActive ? SELECTION_FOOTER_INSET_PX : 0;

    const handleOpenFile = useCallback((file: EnteFile): void => {
        if (useSelectionStore.getState().mode !== "none") {
            return;
        }
        setViewer({ fileId: file.id, files });
    }, [files]);

    const handleCloseViewer = useCallback((): void => {
        setViewer(undefined);
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
            <SelectionActionFooter />
            <StampToolFooter />
            <RotateToolFooter />
            <CropToolFooter />
            {viewer ? (
                <PhotoViewer
                    files={viewer.files}
                    initialFileId={viewer.fileId}
                    onClose={handleCloseViewer}
                    albumCoverFileId={albumCoverFileId}
                    onSetAlbumCover={onSetAlbumCover}
                />
            ) : null}
        </div>
    );
}
