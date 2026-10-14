import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import { Check, GripVertical, Pencil, Plus } from "lucide-react";
import { AlbumEditorPanel } from "@/components/albums/AlbumEditorPanel";
import { AlbumListCard } from "@/components/albums/AlbumListCard";
import { AppShell } from "@/components/AppShell";
import { FilteredMediaView } from "@/components/FilteredMediaView";
import { GallerySortToggle } from "@/components/GallerySortToggle";
import { PageLoader } from "@/components/PageLoader";
import { TagFilterBar } from "@/components/TagFilterBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import { useLibraryBootstrap } from "@/hooks/use-library-bootstrap";
import { useLibraryFiles } from "@/hooks/use-library-files";
import { useLibraryLoading } from "@/hooks/use-library-loading";
import { useMediaDisplayPipeline } from "@/hooks/use-media-display-pipeline";
import { resolveAlbumCoverFile } from "@/lib/album-cover";
import { queryAlbumFilter } from "@/lib/query-albums";
import { filterFilesByTags, isTagFilterActive } from "@/lib/tag-filter";
import type { EnteFile } from "ente-media/file";
import { useSessionStore } from "@/stores/session-store";
import { useAlbumStore } from "@/stores/album-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagStore } from "@/stores/tag-store";
import { toast } from "sonner";

/** Stable empty set so album view can skip favourite-store updates when unused. */
const EMPTY_FAVORITE_FILE_IDS = new Set<number>();

type AlbumsMode = "list" | "view" | "edit";
type ListSubMode = "browse" | "reorder";

export default function AlbumsPage(): JSX.Element {
    const email = useSessionStore((s) => s.email);

    const albums = useAlbumStore((s) => s.albums);
    const deleteAlbum = useAlbumStore((s) => s.deleteAlbum);
    const reorderAlbums = useAlbumStore((s) => s.reorderAlbums);
    const updateAlbum = useAlbumStore((s) => s.updateAlbum);

    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const albumViewFilter = useTagStore((s) => s.albumViewFilter);
    const clearAlbumViewFilter = useTagStore((s) => s.clearAlbumViewFilter);
    const includeInEffectsPresenceByName = useTagStore(
        (s) => s.typeConfig.includeInEffectsPresenceByName,
    );
    const initialLoadDone = useLibraryBootstrap();

    const [mode, setMode] = useState<AlbumsMode>("list");
    const [listSubMode, setListSubMode] = useState<ListSubMode>("browse");
    const [activeAlbumId, setActiveAlbumId] = useState<string | undefined>();
    const [editingNew, setEditingNew] = useState<boolean>(false);
    const [draggingAlbumId, setDraggingAlbumId] = useState<string | undefined>();
    const [dragOverAlbumId, setDragOverAlbumId] = useState<string | undefined>();
    const listRef = useRef<HTMLDivElement>(null);

    const activeAlbum = useMemo(
        () => albums.find((album) => album.id === activeAlbumId),
        [activeAlbumId, albums],
    );

    const activeAlbumQuery = useMemo(
        () => (activeAlbum ? queryAlbumFilter(activeAlbum) : undefined),
        [activeAlbum],
    );

    const libraryFiles = useLibraryFiles();

    const albumFiles = useMemo(() => {
        if (!activeAlbumQuery) {
            return [];
        }
        return filterFilesByTags(
            libraryFiles,
            activeAlbumQuery,
            fileIdsByTag,
            { favoriteFileIds, includeInEffectsPresenceByName },
        );
    }, [
        activeAlbumQuery,
        favoriteFileIds,
        fileIdsByTag,
        includeInEffectsPresenceByName,
        libraryFiles,
    ]);

    const albumFavoritesScopeActive = albumViewFilter.favoritesScope !== "all";
    const albumFavoriteFileIds = useFavoritesStore((s) =>
        albumFavoritesScopeActive ? s.favoriteFileIds : EMPTY_FAVORITE_FILE_IDS);

    const tagFilterForFitSort = useMemo(() => {
        if (!activeAlbumQuery) {
            return albumViewFilter;
        }
        return isTagFilterActive(albumViewFilter) ?
            albumViewFilter :
            activeAlbumQuery;
    }, [activeAlbumQuery, albumViewFilter]);

    const { filteredFiles, displayFiles, matchCount } = useMediaDisplayPipeline({
        libraryFiles,
        tagFilter: albumViewFilter,
        tagFilterForFitSort,
        filterWithinFiles: mode === "view" ? albumFiles : undefined,
        seedWithinFiles: mode === "view" ? albumFiles : undefined,
        favoriteFileIds: albumFavoriteFileIds,
        initialLoadDone,
        clearNearnessOnUnmount: mode === "view",
    });

    /** Count and cover per album from one match pass; list mode only. */
    const albumCardById = useMemo(() => {
        const cards = new Map<
            string,
            { matchCount: number; coverFile: EnteFile | undefined }
        >();
        if (mode !== "list") {
            return cards;
        }
        for (const album of albums) {
            const matches = filterFilesByTags(
                libraryFiles,
                queryAlbumFilter(album),
                fileIdsByTag,
                { favoriteFileIds, includeInEffectsPresenceByName },
            );
            cards.set(album.id, {
                matchCount: matches.length,
                coverFile: resolveAlbumCoverFile(album, matches),
            });
        }
        return cards;
    }, [
        albums,
        favoriteFileIds,
        fileIdsByTag,
        includeInEffectsPresenceByName,
        libraryFiles,
        mode,
    ]);

    const activeAlbumCoverId = useMemo(() => {
        if (!activeAlbum) {
            return undefined;
        }
        return resolveAlbumCoverFile(activeAlbum, albumFiles)?.id;
    }, [activeAlbum, albumFiles]);

    useEffect(() => {
        if (mode === "view") {
            return;
        }
        clearAlbumViewFilter();
    }, [clearAlbumViewFilter, mode]);

    const handleBack = useCallback((): void => {
        useSelectionStore.getState().reset();
        clearAlbumViewFilter();
        setMode("list");
        setListSubMode("browse");
        setActiveAlbumId(undefined);
        setEditingNew(false);
        setDraggingAlbumId(undefined);
        setDragOverAlbumId(undefined);
    }, [clearAlbumViewFilter]);

    const handleOpenAlbum = (albumId: string): void => {
        clearAlbumViewFilter();
        setActiveAlbumId(albumId);
        setMode("view");
        setEditingNew(false);
    };

    const handleEditAlbum = (albumId: string): void => {
        clearAlbumViewFilter();
        setActiveAlbumId(albumId);
        setMode("edit");
        setEditingNew(false);
        setListSubMode("browse");
    };

    const handleCreateAlbum = (): void => {
        setActiveAlbumId(undefined);
        setEditingNew(true);
        setMode("edit");
        setListSubMode("browse");
    };

    const handleDeleteAlbum = (): void => {
        if (!activeAlbumId) {
            return;
        }
        deleteAlbum(activeAlbumId);
        handleBack();
    };

    const findAlbumIdAtY = useCallback((clientY: number): string | undefined => {
        const container = listRef.current;
        if (!container) {
            return undefined;
        }
        const cards = container.querySelectorAll<HTMLElement>("[data-album-id]");
        for (const card of cards) {
            const rect = card.getBoundingClientRect();
            if (clientY >= rect.top && clientY <= rect.bottom) {
                return card.dataset.albumId;
            }
        }
        return undefined;
    }, []);

    const handleDragStart = useCallback((albumId: string): void => {
        setDraggingAlbumId(albumId);
        setDragOverAlbumId(albumId);
    }, []);

    const handleDragMove = useCallback((clientY: number): void => {
        const overId = findAlbumIdAtY(clientY);
        if (overId) {
            setDragOverAlbumId(overId);
        }
    }, [findAlbumIdAtY]);

    const handleDragEnd = useCallback((): void => {
        if (draggingAlbumId && dragOverAlbumId && draggingAlbumId !== dragOverAlbumId) {
            const ids = albums.map((album) => album.id);
            const fromIndex = ids.indexOf(draggingAlbumId);
            const toIndex = ids.indexOf(dragOverAlbumId);
            if (fromIndex >= 0 && toIndex >= 0) {
                const next = [...ids];
                next.splice(fromIndex, 1);
                next.splice(toIndex, 0, draggingAlbumId);
                reorderAlbums(next);
            }
        }
        setDraggingAlbumId(undefined);
        setDragOverAlbumId(undefined);
    }, [albums, dragOverAlbumId, draggingAlbumId, reorderAlbums]);

    const handleSetAlbumCover = useCallback((fileId: number): void => {
        if (!activeAlbum) {
            return;
        }
        updateAlbum(activeAlbum.id, { coverFileId: fileId });
        toast.success("Album cover updated");
    }, [activeAlbum, updateAlbum]);

    const shellTitle =
        mode === "list" ?
            (listSubMode === "reorder" ? "Reorder albums" : "Albums") :
            mode === "edit" ?
                (editingNew ? "New album" : "Edit album") :
                (activeAlbum?.name ?? "Album");

    const albumCountBadge = (count: number): JSX.Element => (
        <Badge variant="secondary" className="shrink-0 tabular-nums">
            {count}
        </Badge>
    );

    const showFullPageLoader = useLibraryLoading(
        initialLoadDone,
        libraryFiles.length,
    );

    return (
        <AppShell
            title={shellTitle}
            titleBadge={
                mode === "view" && activeAlbum ?
                    albumCountBadge(matchCount) :
                    undefined
            }
            email={email}
            mainScrolls={mode !== "view"}
            onBack={mode === "list" ? undefined : handleBack}
            actions={
                mode === "list" ? (
                    <>
                        {albums.length > 1 ? (
                            <Button
                                type="button"
                                variant={listSubMode === "reorder" ? "secondary" : "outline"}
                                size="icon-sm"
                                aria-label={
                                    listSubMode === "reorder" ?
                                        "Done reordering" :
                                        "Reorder albums"
                                }
                                onClick={() => {
                                    setListSubMode((current) =>
                                        current === "reorder" ? "browse" : "reorder");
                                    setDraggingAlbumId(undefined);
                                    setDragOverAlbumId(undefined);
                                }}
                            >
                                {listSubMode === "reorder" ? <Check /> : <GripVertical />}
                            </Button>
                        ) : null}
                        <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            aria-label="Create album"
                            disabled={listSubMode === "reorder"}
                            onClick={handleCreateAlbum}
                        >
                            <Plus />
                        </Button>
                    </>
                ) : mode === "view" && activeAlbum ? (
                    <>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={filteredFiles.length === 0}
                            onClick={() => {
                                useSelectionStore
                                    .getState()
                                    .selectAll(filteredFiles.map((file) => file.id));
                            }}
                        >
                            Select all
                        </Button>
                        <GallerySortToggle />
                        <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            aria-label="Edit album"
                            onClick={() => handleEditAlbum(activeAlbum.id)}
                        >
                            <Pencil />
                        </Button>
                    </>
                ) : null
            }
        >
            {mode === "view" && activeAlbum ? (
                <TagFilterBar
                    filterTarget="album"
                    matchCount={matchCount}
                    matchingFiles={filteredFiles}
                    scopeCandidateFiles={albumFiles}
                    tagFilterFitSource={tagFilterForFitSort}
                />
            ) : null}

            {mode === "list" ? (
                showFullPageLoader ? (
                    <PageLoader message="Loading your library…" />
                ) : albums.length === 0 ? (
                    <Empty className="flex-1 border-0 px-4">
                        <EmptyHeader>
                            <EmptyTitle>No albums yet</EmptyTitle>
                            <EmptyDescription>
                                Create an album with a tag query. Photos that
                                match will appear automatically.
                            </EmptyDescription>
                        </EmptyHeader>
                        <Button type="button" onClick={handleCreateAlbum}>
                            Create album
                        </Button>
                    </Empty>
                ) : (
                    <div ref={listRef} className="flex flex-col gap-3 px-4 py-4">
                        {albums.map((album) => {
                            const albumCard = albumCardById.get(album.id);
                            return (
                                <AlbumListCard
                                    key={album.id}
                                    albumId={album.id}
                                    name={album.name}
                                    matchCount={albumCard?.matchCount ?? 0}
                                    coverFile={albumCard?.coverFile}
                                    reorderMode={listSubMode === "reorder"}
                                    isDragging={draggingAlbumId === album.id}
                                    isDragOver={
                                        dragOverAlbumId === album.id &&
                                        draggingAlbumId !== album.id
                                    }
                                    onOpen={() => handleOpenAlbum(album.id)}
                                    onEdit={() => handleEditAlbum(album.id)}
                                    onDragStart={handleDragStart}
                                    onDragMove={handleDragMove}
                                    onDragEnd={handleDragEnd}
                                />
                            );
                        })}
                    </div>
                )
            ) : null}

            {mode === "view" && activeAlbum ? (
                <FilteredMediaView
                    files={displayFiles}
                    loading={showFullPageLoader}
                    albumCoverFileId={activeAlbumCoverId}
                    onSetAlbumCover={handleSetAlbumCover}
                />
            ) : null}

            {mode === "edit" ? (
                <AlbumEditorPanel
                    key={editingNew ? "new" : activeAlbumId}
                    album={editingNew ? undefined : activeAlbum}
                    onSave={handleBack}
                    onCancel={handleBack}
                    onDelete={
                        editingNew || !activeAlbumId ?
                            undefined :
                            handleDeleteAlbum
                    }
                />
            ) : null}
        </AppShell>
    );
}
