import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type JSX,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import { ArrowDownUp, Shuffle, Upload } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { PageLoader } from "@/components/PageLoader";
import { SyncBanner } from "@/components/SyncBanner";
import { TagFilterBar } from "@/components/TagFilterBar";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import { Button } from "@/components/ui/button";
import { useLibraryBootstrap } from "@/hooks/use-library-bootstrap";
import {
    isSessionAuthenticated,
    reconcileSessionWithCore,
    useSessionStore,
} from "@/stores/session-store";
import { dedupeFilesById } from "@/lib/sync/merge-files";
import { shuffleFiles } from "@/lib/shuffle-files";
import {
    countFilesMatchingTagFilter,
    filterFilesByTags,
} from "@/lib/tags";
import { fileCreationTime } from "ente-media/file-metadata";
import { useLibraryStore } from "@/stores/library-store";
import { useTagStore } from "@/stores/tag-store";
import { useUIStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";

const PhotoViewer = dynamic(
    () =>
        import("@/components/PhotoViewer").then((mod) => ({
            default: mod.PhotoViewer,
        })),
    { ssr: false },
);

const UploadPanel = dynamic(
    () =>
        import("@/components/UploadPanel").then((mod) => ({
            default: mod.UploadPanel,
        })),
    { ssr: false },
);

export default function GalleryPage(): JSX.Element {
    const router = useRouter();
    const email = useSessionStore((s) => s.email);

    const allFiles = useLibraryStore((s) => s.allFiles);
    const tagFilter = useTagStore((s) => s.tagFilter);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const mediaViewOrder = useUIStore((s) => s.mediaViewOrder);
    const mediaShuffleSeed = useUIStore((s) => s.mediaShuffleSeed);
    const setMediaShuffled = useUIStore((s) => s.setMediaShuffled);
    const reshuffleMedia = useUIStore((s) => s.reshuffleMedia);
    const setMediaDefaultOrder = useUIStore((s) => s.setMediaDefaultOrder);
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const initialLoadDone = useLibraryBootstrap();

    const libraryFiles = useMemo(() => {
        const deduped = dedupeFilesById(allFiles);
        return [...deduped].sort(
            (a, b) => fileCreationTime(b) - fileCreationTime(a),
        );
    }, [allFiles]);

    const filteredFiles = useMemo(
        () =>
            filterFilesByTags(
                libraryFiles,
                tagFilter,
                fileIdsByTag,
            ),
        [libraryFiles, tagFilter, fileIdsByTag],
    );

    const files = useMemo(() => {
        if (mediaViewOrder === "shuffled") {
            return shuffleFiles(filteredFiles, mediaShuffleSeed);
        }
        return filteredFiles;
    }, [filteredFiles, mediaShuffleSeed, mediaViewOrder]);

    const matchCount = useMemo(() => {
        const candidateIds = new Set(libraryFiles.map((file) => file.id));
        return countFilesMatchingTagFilter(
            candidateIds,
            tagFilter,
            fileIdsByTag,
            libraryFiles,
        );
    }, [libraryFiles, tagFilter, fileIdsByTag]);

    const [viewerFileId, setViewerFileId] = useState<number | undefined>();
    const [showUpload, setShowUpload] = useState<boolean>(false);

    useEffect(() => {
        reconcileSessionWithCore();
        if (!isSessionAuthenticated()) {
            void router.replace("/login");
        }
    }, [router]);

    const handleOpenFile = useCallback((file: EnteFile): void => {
        setViewerFileId(file.id);
    }, []);

    const handleCloseViewer = useCallback((): void => {
        setViewerFileId(undefined);
    }, []);

    const handleFileUpdated = useCallback((file: EnteFile): void => {
        setViewerFileId(file.id);
    }, []);

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
                    {mediaViewOrder === "default" ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            aria-label="Shuffle"
                            onClick={() => setMediaShuffled(Date.now())}
                        >
                            <Shuffle />
                        </Button>
                    ) : (
                        <>
                            <Button
                                type="button"
                                variant="outline"
                                size="icon-sm"
                                aria-label="Re-shuffle"
                                onClick={reshuffleMedia}
                            >
                                <Shuffle />
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="icon-sm"
                                aria-label="Original order"
                                onClick={setMediaDefaultOrder}
                            >
                                <ArrowDownUp />
                            </Button>
                        </>
                    )}
                    <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label="Upload photo"
                        onClick={() => setShowUpload(true)}
                    >
                        <Upload />
                    </Button>
                </>
            }
        >
            <SyncBanner />
            <TagFilterBar matchCount={matchCount} />

            {showFullPageLoader ? (
                <PageLoader message="Loading your library…" />
            ) : (
                <ThumbnailGrid files={files} onOpenFile={handleOpenFile} />
            )}

            {viewerFileId !== undefined ? (
                <PhotoViewer
                    files={files}
                    initialFileId={viewerFileId}
                    onClose={handleCloseViewer}
                    onFileUpdated={handleFileUpdated}
                />
            ) : null}
            {showUpload ? (
                <UploadPanel
                    onClose={() => setShowUpload(false)}
                    onUploaded={() => setShowUpload(false)}
                />
            ) : null}
        </AppShell>
    );
}
