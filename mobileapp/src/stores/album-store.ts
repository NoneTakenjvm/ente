import { create } from "zustand";
import type { StateCreator } from "zustand";
import { enqueueOrganizerConfigPatch } from "@/lib/organizer-config-save-queue";
import type { PersistedQueryAlbums } from "@/lib/query-albums";
import {
    createQueryAlbum,
    serializeTagFilter,
    type QueryAlbum,
} from "@/lib/query-albums";
import { rewriteQueryAlbumTags } from "@/lib/album-tag-rewrite";
import type { TagFilterGroup, TagFilterSelection } from "@/lib/tag-filter";
import { registerReset } from "@/lib/session-lifecycle";

interface AlbumState {
    albums: QueryAlbum[];
    hydrateFromOrganizerConfig: (config: PersistedQueryAlbums | undefined) => void;
    createAlbum: (name: string, query: TagFilterSelection) => QueryAlbum;
    updateAlbum: (
        id: string,
        patch: {
            name?: string;
            query?: TagFilterSelection;
            coverFileId?: number | null;
        },
    ) => void;
    reorderAlbums: (orderedIds: string[]) => void;
    deleteAlbum: (id: string) => void;
    rewriteAlbumTags: (
        affectedNames: string[],
        rewriteRoot: (root: TagFilterGroup) => TagFilterGroup,
    ) => void;
    reset: () => void;
}

const persistAlbums = (albums: QueryAlbum[]): void => {
    enqueueOrganizerConfigPatch({
        queryAlbums: { albums },
    });
};

const createAlbumStore: StateCreator<AlbumState> = (set, get) => ({
    albums: [],

    hydrateFromOrganizerConfig: (config: PersistedQueryAlbums | undefined): void => {
        set({ albums: config?.albums ?? [] });
    },

    createAlbum: (name: string, query: TagFilterSelection): QueryAlbum => {
        const album = createQueryAlbum(name, query);
        const albums = [...get().albums, album];
        set({ albums });
        persistAlbums(albums);
        return album;
    },

    updateAlbum: (
        id: string,
        patch: {
            name?: string;
            query?: TagFilterSelection;
            coverFileId?: number | null;
        },
    ): void => {
        const albums = get().albums.map((album) => {
            if (album.id !== id) {
                return album;
            }
            const next = { ...album };
            if (patch.name !== undefined) {
                next.name = patch.name.trim();
            }
            if (patch.query !== undefined) {
                next.query = serializeTagFilter(patch.query);
            }
            if (patch.coverFileId === null) {
                delete next.coverFileId;
            } else if (patch.coverFileId !== undefined) {
                next.coverFileId = patch.coverFileId;
            }
            return next;
        });
        set({ albums });
        persistAlbums(albums);
    },

    reorderAlbums: (orderedIds: string[]): void => {
        const byId = new Map(get().albums.map((album) => [album.id, album]));
        if (orderedIds.length !== byId.size) {
            return;
        }
        const albums = orderedIds.map((id) => byId.get(id)).filter(
            (album): album is QueryAlbum => album !== undefined,
        );
        if (albums.length !== byId.size) {
            return;
        }
        set({ albums });
        persistAlbums(albums);
    },

    deleteAlbum: (id: string): void => {
        const albums = get().albums.filter((album) => album.id !== id);
        set({ albums });
        persistAlbums(albums);
    },

    rewriteAlbumTags: (
        affectedNames: string[],
        rewriteRoot: (root: TagFilterGroup) => TagFilterGroup,
    ): void => {
        const tagNames = new Set(affectedNames);
        const current = get().albums;
        const albums = current.map((album) =>
            rewriteQueryAlbumTags(album, tagNames, rewriteRoot));
        if (albums.every((album, index) => album === current[index])) {
            return;
        }
        set({ albums });
        persistAlbums(albums);
    },

    reset: (): void => {
        set({ albums: [] });
    },
});

export const useAlbumStore = create<AlbumState>(createAlbumStore);

registerReset(() => {
    useAlbumStore.getState().reset();
});
