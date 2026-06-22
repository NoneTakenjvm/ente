import { create } from "zustand";
import type { StateCreator } from "zustand";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import {
    createUnsyncedFavoriteUpdate,
    deriveFavoriteFileIDs,
    type UnsyncedFavoriteUpdate,
    type UnsyncedFavoriteUpdateKey,
} from "@/lib/favorites";

interface FavoritesState {
    favoritesCollectionId: number | null;
    favoriteFileIds: Set<number>;
    pendingFavoriteFileIds: Set<number>;
    unsyncedFavoriteUpdates: Map<
        UnsyncedFavoriteUpdateKey,
        UnsyncedFavoriteUpdate
    >;
    rebuildFromLibrary: (
        userId: number,
        collections: Collection[],
        allFiles: EnteFile[],
    ) => void;
    applyOptimisticFavorite: (
        file: EnteFile,
        userId: number,
        isFavorite: boolean,
        collections: Collection[],
        allFiles: EnteFile[],
    ) => boolean;
    revertOptimisticFavorite: (
        file: EnteFile,
        userId: number,
        wasFavorite: boolean,
        collections: Collection[],
        allFiles: EnteFile[],
    ) => void;
    addPending: (fileId: number) => void;
    removePending: (fileId: number) => void;
    removeTrashedFileIds: (fileIds: number[]) => void;
    clearUnsynced: () => void;
    reset: () => void;
}

const initialState: Pick<
    FavoritesState,
    | "favoritesCollectionId" |
    "favoriteFileIds" |
    "pendingFavoriteFileIds" |
    "unsyncedFavoriteUpdates"
> = {
    favoritesCollectionId: null,
    favoriteFileIds: new Set(),
    pendingFavoriteFileIds: new Set(),
    unsyncedFavoriteUpdates: new Map(),
};

const createFavoritesStore: StateCreator<FavoritesState> = (set, get) => ({
    ...initialState,

    rebuildFromLibrary: (
        userId: number,
        collections: Collection[],
        allFiles: EnteFile[],
    ): void => {
        const { favoritesCollectionId, favoriteFileIds } = deriveFavoriteFileIDs(
            userId,
            collections,
            allFiles,
        );
        set({
            favoritesCollectionId,
            favoriteFileIds,
            unsyncedFavoriteUpdates: new Map(),
        });
    },

    applyOptimisticFavorite: (
        file: EnteFile,
        userId: number,
        isFavorite: boolean,
        collections: Collection[],
        allFiles: EnteFile[],
    ): boolean => {
        const unsyncedFavoriteUpdates = new Map(get().unsyncedFavoriteUpdates);
        const { key, update } = createUnsyncedFavoriteUpdate(
            file,
            userId,
            isFavorite,
        );
        unsyncedFavoriteUpdates.set(key, update);

        const { favoritesCollectionId, favoriteFileIds } = deriveFavoriteFileIDs(
            userId,
            collections,
            allFiles,
            unsyncedFavoriteUpdates,
        );
        set({
            unsyncedFavoriteUpdates,
            favoritesCollectionId,
            favoriteFileIds,
        });
        return favoriteFileIds.has(file.id);
    },

    revertOptimisticFavorite: (
        file: EnteFile,
        userId: number,
        wasFavorite: boolean,
        collections: Collection[],
        allFiles: EnteFile[],
    ): void => {
        const unsyncedFavoriteUpdates = new Map(get().unsyncedFavoriteUpdates);
        const { key } = createUnsyncedFavoriteUpdate(
            file,
            userId,
            !wasFavorite,
        );
        unsyncedFavoriteUpdates.delete(key);

        const { favoritesCollectionId, favoriteFileIds } = deriveFavoriteFileIDs(
            userId,
            collections,
            allFiles,
            unsyncedFavoriteUpdates,
        );
        set({
            unsyncedFavoriteUpdates,
            favoritesCollectionId,
            favoriteFileIds,
        });
    },

    addPending: (fileId: number): void => {
        const pendingFavoriteFileIds = new Set(get().pendingFavoriteFileIds);
        pendingFavoriteFileIds.add(fileId);
        set({ pendingFavoriteFileIds });
    },

    removePending: (fileId: number): void => {
        const pendingFavoriteFileIds = new Set(get().pendingFavoriteFileIds);
        pendingFavoriteFileIds.delete(fileId);
        set({ pendingFavoriteFileIds });
    },

    removeTrashedFileIds: (fileIds: number[]): void => {
        if (!fileIds.length) {
            return;
        }
        const trashed = new Set(fileIds);
        const favoriteFileIds = new Set(get().favoriteFileIds);
        const pendingFavoriteFileIds = new Set(get().pendingFavoriteFileIds);
        for (const fileId of trashed) {
            favoriteFileIds.delete(fileId);
            pendingFavoriteFileIds.delete(fileId);
        }
        set({ favoriteFileIds, pendingFavoriteFileIds });
    },

    clearUnsynced: (): void => {
        set({ unsyncedFavoriteUpdates: new Map() });
    },

    reset: (): void => {
        pendingFavoriteFilesByHashAndType.clear();
        set(initialState);
    },
});

export const useFavoritesStore = create<FavoritesState>(createFavoritesStore);

export const pendingFavoriteFilesByHashAndType = new Map<string, EnteFile>();
