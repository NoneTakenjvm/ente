import { useEffect, useState, type JSX } from "react";
import { Upload } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { FilteredMediaView } from "@/components/FilteredMediaView";
import { GallerySortToggle } from "@/components/GallerySortToggle";
import { PageLoader } from "@/components/PageLoader";
import { TagFilterBar } from "@/components/TagFilterBar";
import { Button } from "@/components/ui/button";
import { useLibraryBootstrap } from "@/hooks/use-library-bootstrap";
import { useLibraryFiles } from "@/hooks/use-library-files";
import { useLibraryLoading } from "@/hooks/use-library-loading";
import { useMediaDisplayPipeline } from "@/hooks/use-media-display-pipeline";
import { useSessionStore } from "@/stores/session-store";
import { useLibraryStore } from "@/stores/library-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useTagStore } from "@/stores/tag-store";
import { useUploadJobStore } from "@/stores/ui-store";

/** Stable empty set so gallery can skip favourite-store updates when unused. */
const EMPTY_FAVORITE_FILE_IDS = new Set<number>();

const formatPhotoCount = (count: number): string =>
    count.toLocaleString();

/**
 * Light Media route shell — paints AppShell + prepare loader before the heavy
 * filter/sort/grid subtree mounts (see {@link GalleryMediaBody}).
 */
export default function GalleryPage(): JSX.Element {
    const email = useSessionStore((s) => s.email);
    const libraryFileCount = useLibraryStore((s) => s.allFiles.length);
    const setUploadPanelOpen = useUploadJobStore((s) => s.setPanelOpen);
    const [bodyMounted, setBodyMounted] = useState(false);

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

    return (
        <AppShell
            title="Media"
            email={email}
            mainScrolls={false}
            actions={
                <>
                    <GallerySortToggle />
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
    const tagFilter = useTagStore((s) => s.tagFilter);
    const favoritesScopeActive = tagFilter.favoritesScope !== "all";
    const favoriteFileIds = useFavoritesStore((s) =>
        favoritesScopeActive ? s.favoriteFileIds : EMPTY_FAVORITE_FILE_IDS);
    const initialLoadDone = useLibraryBootstrap();
    const libraryFiles = useLibraryFiles();

    const { filteredFiles, displayFiles, matchCount } = useMediaDisplayPipeline({
        libraryFiles,
        tagFilter,
        favoriteFileIds,
        initialLoadDone,
        clearNearnessOnUnmount: true,
    });

    const showFullPageLoader = useLibraryLoading(
        initialLoadDone,
        displayFiles.length,
    );

    return (
        <>
            <TagFilterBar
                matchCount={matchCount}
                matchingFiles={filteredFiles}
            />
            <FilteredMediaView
                files={displayFiles}
                loading={showFullPageLoader}
            />
        </>
    );
}
