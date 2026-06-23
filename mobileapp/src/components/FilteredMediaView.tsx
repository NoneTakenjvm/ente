import dynamic from "next/dynamic";
import {
    useCallback,
    useMemo,
    useState,
    type JSX,
} from "react";
import { PageLoader } from "@/components/PageLoader";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import { shuffleFiles } from "@/lib/shuffle-files";
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

    const displayFiles = useMemo(() => {
        if (viewOrder === "shuffled") {
            return shuffleFiles(files, shuffleSeed);
        }
        return files;
    }, [files, shuffleSeed, viewOrder]);

    const handleOpenFile = useCallback((file: EnteFile): void => {
        setViewerFileId(file.id);
    }, []);

    const handleCloseViewer = useCallback((): void => {
        setViewerFileId(undefined);
    }, []);

    const handleFileUpdated = useCallback((file: EnteFile): void => {
        setViewerFileId(file.id);
    }, []);

    if (loading && files.length === 0) {
        return <PageLoader message={loadingMessage} />;
    }

    return (
        <>
            <ThumbnailGrid files={displayFiles} onOpenFile={handleOpenFile} />
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
