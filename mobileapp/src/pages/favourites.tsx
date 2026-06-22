import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type JSX,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import { AppShell } from "@/components/AppShell";
import { PageLoader } from "@/components/PageLoader";
import { SyncBanner } from "@/components/SyncBanner";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "@/components/ui/empty";
import { useLibraryBootstrap } from "@/hooks/use-library-bootstrap";
import { filterFavoriteCollectionFiles } from "@/lib/favorites";
import { fileCreationTime } from "ente-media/file-metadata";
import { Heart } from "lucide-react";
import {
    isSessionAuthenticated,
    reconcileSessionWithCore,
    useSessionStore,
} from "@/stores/session-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import type { EnteFile } from "ente-media/file";

const PhotoViewer = dynamic(
    () =>
        import("@/components/PhotoViewer").then((mod) => ({
            default: mod.PhotoViewer,
        })),
    { ssr: false },
);

export default function FavouritesPage(): JSX.Element {
    const router = useRouter();
    const email = useSessionStore((s) => s.email);

    const allFiles = useLibraryStore((s) => s.allFiles);
    const favoritesCollectionId = useFavoritesStore((s) => s.favoritesCollectionId);
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const initialLoadDone = useLibraryBootstrap();

    const files = useMemo(() => {
        const favoriteFiles = filterFavoriteCollectionFiles(
            allFiles,
            favoritesCollectionId,
        );
        return [...favoriteFiles].sort(
            (a, b) => fileCreationTime(b) - fileCreationTime(a),
        );
    }, [allFiles, favoritesCollectionId]);

    const [viewerFileId, setViewerFileId] = useState<number | undefined>();

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
        <AppShell title="Favourites" email={email}>
            <SyncBanner />

            {showFullPageLoader ? (
                <PageLoader message="Loading favourites…" />
            ) : files.length === 0 ? (
                <Empty className="flex-1 border-0">
                    <EmptyHeader>
                        <EmptyMedia variant="icon">
                            <Heart />
                        </EmptyMedia>
                        <EmptyTitle>No favourites yet</EmptyTitle>
                        <EmptyDescription>
                            Star a photo in the gallery to add it here.
                        </EmptyDescription>
                    </EmptyHeader>
                </Empty>
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
        </AppShell>
    );
}
