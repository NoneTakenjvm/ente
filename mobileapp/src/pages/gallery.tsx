import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type JSX,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import { ShieldOff, Upload } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { ConfirmPanicModal } from "@/components/ConfirmPanicModal";
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
import { reconcileShuffledIds } from "@/lib/shuffle-files";
import {
    countFilesMatchingTagFilter,
    filterFilesByTags,
} from "@/lib/tags";
import { fileCreationTime } from "ente-media/file-metadata";
import { useLibraryStore } from "@/stores/library-store";
import { useFavoritesStore } from "@/stores/favorites-store";
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
    const setUploadPanelOpen = useUploadJobStore((s) => s.setPanelOpen);
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
                { favoriteFileIds },
            ),
        [libraryFiles, tagFilter, fileIdsByTag, favoriteFileIds],
    );

    useEffect(() => {
        if (mediaViewOrder !== "shuffled") {
            return;
        }
        reconcileMediaShuffle(filteredFiles.map((file) => file.id));
    }, [filteredFiles, mediaViewOrder, reconcileMediaShuffle]);

    const files = useMemo(() => {
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

    const [viewerFileId, setViewerFileId] = useState<number | undefined>();
    const [showPanicConfirm, setShowPanicConfirm] = useState<boolean>(false);
    const [panicWorking, setPanicWorking] = useState<boolean>(false);
    const panic = useSessionStore((s) => s.panic);

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

    const handlePanicConfirm = useCallback((): void => {
        setPanicWorking(true);
        void panic()
            .then(() => {
                window.close();
                void router.replace("/login");
            })
            .finally(() => {
                setPanicWorking(false);
                setShowPanicConfirm(false);
            });
    }, [panic, router]);

    const handleFileUpdated = useCallback((file: EnteFile): void => {
        setViewerFileId((current) =>
            current === undefined ? undefined : file.id);
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
                    <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label="Upload images"
                        onClick={() => setUploadPanelOpen(true)}
                    >
                        <Upload />
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        className="text-destructive hover:text-destructive"
                        aria-label="Wipe local data"
                        onClick={() => setShowPanicConfirm(true)}
                    >
                        <ShieldOff />
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
            <ConfirmPanicModal
                open={showPanicConfirm}
                isWorking={panicWorking}
                onCancel={() => setShowPanicConfirm(false)}
                onConfirm={handlePanicConfirm}
            />
        </AppShell>
    );
}
