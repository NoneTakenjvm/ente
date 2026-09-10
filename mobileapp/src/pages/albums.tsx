import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import { useRouter } from "next/router";
import { Check, GripVertical, Pencil, Plus, Shuffle } from "lucide-react";
import { AlbumEditorPanel } from "@/components/albums/AlbumEditorPanel";
import { AlbumListCard } from "@/components/albums/AlbumListCard";
import { AppShell } from "@/components/AppShell";
import {
    FilteredMediaView,
    type MediaViewOrder,
} from "@/components/FilteredMediaView";
import { PageLoader } from "@/components/PageLoader";
import { GalleryToolsMenu } from "@/components/GalleryToolsMenu";
import { SelectionActionFooter } from "@/components/SelectionActionFooter";
import { StampToolFooter } from "@/components/StampToolFooter";
import { RotateToolFooter } from "@/components/RotateToolFooter";
import { SyncBanner } from "@/components/SyncBanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import { useLibraryBootstrap } from "@/hooks/use-library-bootstrap";
import { resolveAlbumCoverFile } from "@/lib/album-cover";
import { queryAlbumFilter } from "@/lib/query-albums";
import { dedupeFilesById } from "@/lib/sync/merge-files";
import {
    countFilesMatchingTagFilter,
    filterFilesByTags,
} from "@/lib/tags";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import { sortFilesByUpload } from "@/lib/sort-files";
import type { EnteFile } from "ente-media/file";
import {
    isSessionAuthenticated,
    reconcileSessionWithCore,
    useSessionStore,
} from "@/stores/session-store";
import { useAlbumStore } from "@/stores/album-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagStore } from "@/stores/tag-store";
import { toast } from "sonner";

type AlbumsMode = "list" | "view" | "edit";
type ListSubMode = "browse" | "reorder";

export default function AlbumsPage(): JSX.Element {
    const router = useRouter();
    const email = useSessionStore((s) => s.email);

    const albums = useAlbumStore((s) => s.albums);
    const deleteAlbum = useAlbumStore((s) => s.deleteAlbum);
    const reorderAlbums = useAlbumStore((s) => s.reorderAlbums);
    const updateAlbum = useAlbumStore((s) => s.updateAlbum);

    const allFiles = useLibraryStore((s) => s.allFiles);
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const includeInEffectsPresenceByName = useTagStore(
        (s) => s.includeInEffectsPresenceByName,
    );
    const initialLoadDone = useLibraryBootstrap();

    const [mode, setMode] = useState<AlbumsMode>("list");
    const [listSubMode, setListSubMode] = useState<ListSubMode>("browse");
    const [activeAlbumId, setActiveAlbumId] = useState<string | undefined>();
    const [editingNew, setEditingNew] = useState<boolean>(false);
    const [viewOrder, setViewOrder] = useState<MediaViewOrder>("default");
    const [shuffleSeed, setShuffleSeed] = useState<number>(0);
    const [draggingAlbumId, setDraggingAlbumId] = useState<string | undefined>();
    const [dragOverAlbumId, setDragOverAlbumId] = useState<string | undefined>();
    const listRef = useRef<HTMLDivElement>(null);

    const activeAlbum = useMemo(
        () => albums.find((album) => album.id === activeAlbumId),
        [activeAlbumId, albums],
    );

    const libraryFiles = useMemo(() => {
        const deduped = dedupeFilesById(allFiles).filter(
            (file) => !isFileArchivedLocally(file),
        );
        return sortFilesByUpload(deduped);
    }, [allFiles]);

    const libraryFileIds = useMemo(
        (): Set<number> => new Set(libraryFiles.map((file) => file.id)),
        [libraryFiles],
    );

    const albumMatchCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const album of albums) {
            const filter = queryAlbumFilter(album);
            counts.set(
                album.id,
                countFilesMatchingTagFilter(
                    libraryFileIds,
                    filter,
                    fileIdsByTag,
                    libraryFiles,
                    { favoriteFileIds, includeInEffectsPresenceByName },
                ),
            );
        }
        return counts;
    }, [
        albums,
        favoriteFileIds,
        fileIdsByTag,
        includeInEffectsPresenceByName,
        libraryFileIds,
        libraryFiles,
    ]);

    const albumCoverById = useMemo(() => {
        const covers = new Map<string, EnteFile | undefined>();
        for (const album of albums) {
            const filter = queryAlbumFilter(album);
            const matches = filterFilesByTags(
                libraryFiles,
                filter,
                fileIdsByTag,
                { favoriteFileIds, includeInEffectsPresenceByName },
            );
            covers.set(album.id, resolveAlbumCoverFile(album, matches));
        }
        return covers;
    }, [
        albums,
        favoriteFileIds,
        fileIdsByTag,
        includeInEffectsPresenceByName,
        libraryFiles,
    ]);

    const viewFiles = useMemo(() => {
        if (!activeAlbum) {
            return [];
        }
        const filter = queryAlbumFilter(activeAlbum);
        return filterFilesByTags(
            libraryFiles,
            filter,
            fileIdsByTag,
            { favoriteFileIds, includeInEffectsPresenceByName },
        );
    }, [
        activeAlbum,
        favoriteFileIds,
        fileIdsByTag,
        includeInEffectsPresenceByName,
        libraryFiles,
    ]);

    const activeAlbumCoverId = useMemo(() => {
        if (!activeAlbum) {
            return undefined;
        }
        return resolveAlbumCoverFile(activeAlbum, viewFiles)?.id;
    }, [activeAlbum, viewFiles]);

    useEffect(() => {
        reconcileSessionWithCore();
        if (!isSessionAuthenticated()) {
            void router.replace("/login");
        }
    }, [router]);

    useEffect(() => {
        return (): void => {
            useSelectionStore.getState().reset();
        };
    }, []);

    const handleBack = useCallback((): void => {
        useSelectionStore.getState().reset();
        setMode("list");
        setListSubMode("browse");
        setActiveAlbumId(undefined);
        setEditingNew(false);
        setViewOrder("default");
        setShuffleSeed(0);
        setDraggingAlbumId(undefined);
        setDragOverAlbumId(undefined);
    }, []);

    const handleOpenAlbum = (albumId: string): void => {
        setActiveAlbumId(albumId);
        setMode("view");
        setEditingNew(false);
        setViewOrder("default");
        setShuffleSeed(0);
    };

    const handleEditAlbum = (albumId: string): void => {
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

    const activeAlbumCount =
        activeAlbum ? (albumMatchCounts.get(activeAlbum.id) ?? viewFiles.length) : 0;

    const albumCountBadge = (count: number): JSX.Element => (
        <Badge variant="secondary" className="shrink-0 tabular-nums">
            {count}
        </Badge>
    );

    const showFullPageLoader =
        !initialLoadDone &&
        (syncStatus === "loadingFromCache" || syncStatus === "syncing") &&
        libraryFiles.length === 0;

    if (!isSessionAuthenticated()) {
        return <PageLoader message="Redirecting to sign in…" />;
    }

    return (
        <AppShell
            title={shellTitle}
            titleBadge={
                mode === "view" && activeAlbum ?
                    albumCountBadge(activeAlbumCount) :
                    undefined
            }
            email={email}
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
                            disabled={viewFiles.length === 0}
                            onClick={() => {
                                useSelectionStore
                                    .getState()
                                    .selectAll(viewFiles.map((file) => file.id));
                            }}
                        >
                            Select all
                        </Button>
                        <GalleryToolsMenu />
                        <Button
                            type="button"
                            variant={viewOrder === "shuffled" ? "secondary" : "outline"}
                            size="icon-sm"
                            aria-label={
                                viewOrder === "shuffled" ?
                                    "Disable shuffle" :
                                    "Shuffle"
                            }
                            aria-pressed={viewOrder === "shuffled"}
                            onClick={() => {
                                if (viewOrder === "shuffled") {
                                    setViewOrder("default");
                                    setShuffleSeed(0);
                                } else {
                                    setShuffleSeed(Date.now());
                                    setViewOrder("shuffled");
                                }
                            }}
                        >
                            <Shuffle />
                        </Button>
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
            <SyncBanner />

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
                            const matchCount = albumMatchCounts.get(album.id) ?? 0;
                            return (
                                <AlbumListCard
                                    key={album.id}
                                    albumId={album.id}
                                    name={album.name}
                                    matchCount={matchCount}
                                    coverFile={albumCoverById.get(album.id)}
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
                    files={viewFiles}
                    loading={showFullPageLoader}
                    viewOrder={viewOrder}
                    shuffleSeed={shuffleSeed}
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

            <SelectionActionFooter />
            <StampToolFooter />
            <RotateToolFooter />
        </AppShell>
    );
}
