import { create } from "zustand";
import type { StateCreator } from "zustand";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import {
    applyFavoriteUpdateToIds,
    createUnsyncedFavoriteUpdate,
    deriveFavoriteFileIDs,
    findUserFavoritesCollection,
    mergePendingFavoriteUpdates,
    type UnsyncedFavoriteUpdate,
    type UnsyncedFavoriteUpdateKey,
} from "@/lib/favorites";
import { unsyncedUpdatesFromFavoriteOutbox } from "@/lib/favorite-outbox";

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
        const baseline = deriveFavoriteFileIDs(userId, collections, allFiles);
        const unsyncedFavoriteUpdates = mergePendingFavoriteUpdates(
            get().unsyncedFavoriteUpdates,
            unsyncedUpdatesFromFavoriteOutbox(),
            baseline.favoriteFileIds,
        );
        const { favoritesCollectionId, favoriteFileIds } = deriveFavoriteFileIDs(
            userId,
            collections,
            allFiles,
            unsyncedFavoriteUpdates,
        );
        set({
            favoritesCollectionId,
            favoriteFileIds,
            unsyncedFavoriteUpdates,
        });
    },

    applyOptimisticFavorite: (
        file: EnteFile,
        userId: number,
        isFavorite: boolean,
        collections: Collection[],
        allFiles: EnteFile[],
    ): boolean => {
        const state = get();
        const unsyncedFavoriteUpdates = new Map(state.unsyncedFavoriteUpdates);
        const { key, update } = createUnsyncedFavoriteUpdate(
            file,
            userId,
            isFavorite,
        );
        unsyncedFavoriteUpdates.set(key, update);

        const favoriteFileIds = applyFavoriteUpdateToIds(
            state.favoriteFileIds,
            update,
            userId,
            allFiles,
        );
        const pendingFavoriteFileIds = new Set(state.pendingFavoriteFileIds);
        pendingFavoriteFileIds.add(file.id);

        const favoritesCollection =
            state.favoritesCollectionId !== null ?
                undefined :
                findUserFavoritesCollection(collections, userId);

        set({
            unsyncedFavoriteUpdates,
            favoriteFileIds,
            pendingFavoriteFileIds,
            ...(favoritesCollection ?
                { favoritesCollectionId: favoritesCollection.id } :
                {}),
        });
        return favoriteFileIds.has(file.id);
    },

    revertOptimisticFavorite: (
        file: EnteFile,
        userId: number,
        wasFavorite: boolean,
        _collections: Collection[],
        allFiles: EnteFile[],
    ): void => {
        const state = get();
        const unsyncedFavoriteUpdates = new Map(state.unsyncedFavoriteUpdates);
        const { key, update } = createUnsyncedFavoriteUpdate(
            file,
            userId,
            !wasFavorite,
        );
        unsyncedFavoriteUpdates.delete(key);

        const favoriteFileIds = applyFavoriteUpdateToIds(
            state.favoriteFileIds,
            { ...update, isFavorite: wasFavorite },
            userId,
            allFiles,
        );
        set({
            unsyncedFavoriteUpdates,
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
        const unsyncedFavoriteUpdates = new Map(get().unsyncedFavoriteUpdates);
        for (const [key, update] of unsyncedFavoriteUpdates) {
            if (trashed.has(update.fileID)) {
                unsyncedFavoriteUpdates.delete(key);
            }
        }
        set({ favoriteFileIds, pendingFavoriteFileIds, unsyncedFavoriteUpdates });
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
