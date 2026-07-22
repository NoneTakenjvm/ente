import { create } from "zustand";
import type { StateCreator } from "zustand";
import { getEnteCore } from "@/core";
import { getTrashLastUpdatedAt } from "@/db/cursors";
import {
    loadEncryptedTrashItems,
    saveEncryptedTrashItems,
} from "@/db/kv";
import { deleteThumbnailCiphertext } from "@/db/thumbnails";
import { getSessionCacheKey } from "@/lib/cache-key";
import { clearEditHistory } from "@/lib/edit-history";
import { clearLocalMediaOverride } from "@/lib/local-media-overrides";
import { pullTrash, type TrashItem } from "@/lib/sync/pull-trash";
import { invalidateVideoCache } from "@/lib/video-media-cache";
import { fileCreationTime } from "ente-media/file-metadata";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const sortTrashItems = (items: TrashItem[]): TrashItem[] =>
    [...items].sort((a, b) => {
        if (a.deleteBy === b.deleteBy) {
            const at = fileCreationTime(a.file);
            const bt = fileCreationTime(b.file);
            return at === bt ?
                b.file.metadata.modificationTime - a.file.metadata.modificationTime :
                bt - at;
        }
        return b.deleteBy - a.deleteBy;
    });

const pruneLocalCachesForFileIds = async (
    fileIds: number[],
): Promise<void> => {
    await Promise.all(
        fileIds.map(async (fileId) => {
            invalidateVideoCache(fileId);
            clearLocalMediaOverride(fileId);
            clearEditHistory(fileId);
            await deleteThumbnailCiphertext(fileId);
        }),
    );
};

interface TrashState {
    items: TrashItem[];
    lastUpdatedAt: number;
    isHydrated: boolean;
    isSyncing: boolean;
    errorMessage: string | undefined;
    hydrateFromCache: () => Promise<void>;
    syncTrash: (collections: Collection[]) => Promise<void>;
    seedTrashedFiles: (files: EnteFile[]) => Promise<void>;
    restoreToCollection: (
        fileIds: number[],
        collection: Collection,
    ) => Promise<EnteFile[]>;
    deleteForever: (fileIds: number[]) => Promise<void>;
    emptyTrash: () => Promise<void>;
    reset: () => void;
}

const initialState = {
    items: [] as TrashItem[],
    lastUpdatedAt: 0,
    isHydrated: false,
    isSyncing: false,
    errorMessage: undefined as string | undefined,
};

const persistItems = async (items: TrashItem[]): Promise<void> => {
    await saveEncryptedTrashItems(items, getSessionCacheKey());
};

const createTrashStore: StateCreator<TrashState> = (set, get) => ({
    ...initialState,

    hydrateFromCache: async (): Promise<void> => {
        try {
            const cacheKey = getSessionCacheKey();
            const [items, lastUpdatedAt] = await Promise.all([
                loadEncryptedTrashItems(cacheKey),
                getTrashLastUpdatedAt(),
            ]);
            set({
                items: sortTrashItems(items ?? []),
                lastUpdatedAt: lastUpdatedAt ?? 0,
                isHydrated: true,
                errorMessage: undefined,
            });
        } catch (error) {
            set({
                isHydrated: true,
                errorMessage:
                    error instanceof Error ?
                        error.message :
                        "Could not load trash",
            });
        }
    },

    syncTrash: async (collections: Collection[]): Promise<void> => {
        set({ isSyncing: true, errorMessage: undefined });
        try {
            const result = await pullTrash(collections);
            if (result.permanentlyDeletedFileIds.length) {
                await pruneLocalCachesForFileIds(
                    result.permanentlyDeletedFileIds,
                );
            }
            // Merge optimistic seeds that arrived during the pull and were
            // preserved on disk by pullTrash's final re-read.
            const byId = new Map(
                result.items.map((item) => [item.file.id, item]),
            );
            const deleted = new Set(result.permanentlyDeletedFileIds);
            for (const item of get().items) {
                if (deleted.has(item.file.id) || byId.has(item.file.id)) {
                    continue;
                }
                byId.set(item.file.id, item);
            }
            const items = sortTrashItems([...byId.values()]);
            set({
                items,
                lastUpdatedAt: result.lastUpdatedAt,
                isHydrated: true,
                isSyncing: false,
            });
            await persistItems(items);
        } catch (error) {
            set({
                isSyncing: false,
                errorMessage:
                    error instanceof Error ?
                        error.message :
                        "Trash sync failed",
            });
            throw error;
        }
    },

    seedTrashedFiles: async (files: EnteFile[]): Promise<void> => {
        if (!files.length) {
            return;
        }
        const nowMicros = Date.now() * 1000;
        const deleteBy = (Date.now() + TRASH_RETENTION_MS) * 1000;
        const byId = new Map(get().items.map((item) => [item.file.id, item]));
        for (const file of files) {
            byId.set(file.id, {
                file,
                updatedAt: nowMicros,
                deleteBy,
            });
        }
        const items = sortTrashItems([...byId.values()]);
        set({ items, isHydrated: true });
        await persistItems(items);
    },

    restoreToCollection: async (
        fileIds: number[],
        collection: Collection,
    ): Promise<EnteFile[]> => {
        const idSet = new Set(fileIds);
        const restoring = get().items.filter((item) => idSet.has(item.file.id));
        if (!restoring.length) {
            return [];
        }
        const files = restoring.map((item) => item.file);
        await getEnteCore().restoreFilesFromTrash(collection, files);
        const remaining = get().items.filter((item) => !idSet.has(item.file.id));
        set({ items: remaining });
        await persistItems(remaining);
        return files.map((file) => ({
            ...file,
            collectionID: collection.id,
        }));
    },

    deleteForever: async (fileIds: number[]): Promise<void> => {
        const uniqueIds = [...new Set(fileIds)];
        if (!uniqueIds.length) {
            return;
        }
        await getEnteCore().deleteFilesFromTrash(uniqueIds);
        const remaining = get().items.filter(
            (item) => !uniqueIds.includes(item.file.id),
        );
        set({ items: remaining });
        await persistItems(remaining);
        await pruneLocalCachesForFileIds(uniqueIds);
    },

    emptyTrash: async (): Promise<void> => {
        // Remote only deletes entries with updatedAt <= lastUpdatedAt. Prefer
        // the newest timestamp we know about (cursor or local items).
        const fromItems = get().items.reduce(
            (max, item) => Math.max(max, item.updatedAt),
            0,
        );
        const persisted = (await getTrashLastUpdatedAt()) ?? 0;
        let lastUpdatedAt = Math.max(
            get().lastUpdatedAt,
            fromItems,
            persisted,
        );
        if (get().items.length > 0 && lastUpdatedAt <= 0) {
            // Seeded-only trash with no sync yet — pull first so the cursor
            // covers remote entries before emptying.
            const collections = (
                await import("@/stores/library-store")
            ).useLibraryStore.getState().collections;
            await get().syncTrash(collections);
            lastUpdatedAt = Math.max(
                get().lastUpdatedAt,
                get().items.reduce(
                    (max, item) => Math.max(max, item.updatedAt),
                    0,
                ),
            );
        }
        const fileIds = get().items.map((item) => item.file.id);
        await getEnteCore().emptyTrash(lastUpdatedAt);
        set({ items: [], lastUpdatedAt });
        await persistItems([]);
        if (fileIds.length) {
            await pruneLocalCachesForFileIds(fileIds);
        }
    },

    reset: (): void => {
        set({ ...initialState });
    },
});

export const useTrashStore = create<TrashState>(createTrashStore);
