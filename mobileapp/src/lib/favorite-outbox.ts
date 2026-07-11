import type { EnteFile } from "ente-media/file";
import type { Collection } from "ente-media/collection";
import {
    loadEncryptedFavoriteOutbox,
    saveEncryptedFavoriteOutbox,
    type PersistedFavoriteOutboxEntry,
} from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";
import {
    deriveFavoriteFileIDs,
    hashAndTypeKey,
    isFileFavorited,
} from "@/lib/favorites";

export interface FavoriteOutboxEntry {
    fileId: number;
    isFavorite: boolean;
    fileHashAndTypeKey?: string;
    enqueuedAt: number;
}

const outboxByKey = new Map<string, FavoriteOutboxEntry>();
let hydrated = false;
let persistChain: Promise<void> = Promise.resolve();

const entryKey = (entry: FavoriteOutboxEntry): string =>
    entry.fileHashAndTypeKey ?? String(entry.fileId);

const toPersisted = (
    entry: FavoriteOutboxEntry,
): PersistedFavoriteOutboxEntry => ({
    fileId: entry.fileId,
    isFavorite: entry.isFavorite,
    fileHashAndTypeKey: entry.fileHashAndTypeKey,
    enqueuedAt: entry.enqueuedAt,
});

const flushFavoriteOutboxToDisk = async (): Promise<void> => {
    const entries = [...outboxByKey.values()].map(toPersisted);
    await saveEncryptedFavoriteOutbox(entries, getSessionCacheKey());
};

const persistFavoriteOutbox = (): Promise<void> => {
    persistChain = persistChain.then(() => flushFavoriteOutboxToDisk());
    return persistChain;
};

/**
 * Load the encrypted favourite outbox from IndexedDB into memory.
 */
export const hydrateFavoriteOutbox = async (): Promise<void> => {
    const persisted = await loadEncryptedFavoriteOutbox(getSessionCacheKey());
    outboxByKey.clear();
    for (const entry of persisted ?? []) {
        outboxByKey.set(entryKey(entry), entry);
    }
    hydrated = true;
};

export const ensureFavoriteOutboxHydrated = async (): Promise<void> => {
    if (hydrated) {
        return;
    }
    await hydrateFavoriteOutbox();
};

export const isFavoriteOutboxHydrated = (): boolean => hydrated;

/**
 * Queue or replace a pending favourite mutation for a file.
 */
export const upsertFavoriteOutboxEntry = async (
    file: EnteFile,
    userId: number,
    isFavorite: boolean,
): Promise<void> => {
    if (!hydrated) {
        await hydrateFavoriteOutbox();
    }
    const fileHashAndTypeKey =
        file.ownerID !== userId ? hashAndTypeKey(file) : undefined;
    const entry: FavoriteOutboxEntry = {
        fileId: file.id,
        isFavorite,
        fileHashAndTypeKey: fileHashAndTypeKey ?? undefined,
        enqueuedAt: Date.now(),
    };
    outboxByKey.set(entryKey(entry), entry);
    await persistFavoriteOutbox();
};

export const removeFavoriteOutboxEntries = async (
    keys: string[],
): Promise<void> => {
    if (!keys.length) {
        return;
    }
    for (const key of keys) {
        outboxByKey.delete(key);
    }
    await persistFavoriteOutbox();
};

export const getFavoriteOutboxEntries = (): FavoriteOutboxEntry[] =>
    [...outboxByKey.values()];

/**
 * Remap a pending favourite entry when a derived replace changes the file id.
 */
export const remapFavoriteOutboxFileId = async (
    fromFileId: number,
    toFileId: number,
): Promise<void> => {
    if (!hydrated) {
        await hydrateFavoriteOutbox();
    }
    const existing = outboxByKey.get(String(fromFileId));
    if (!existing) {
        return;
    }
    outboxByKey.delete(String(fromFileId));
    outboxByKey.set(String(toFileId), {
        ...existing,
        fileId: toFileId,
    });
    await persistFavoriteOutbox();
};

/**
 * Drop outbox entries whose synced library already matches intent.
 */
export const reconcileFavoriteOutboxWithLibrary = async (
    userId: number,
    collections: Collection[],
    files: EnteFile[],
): Promise<void> => {
    if (outboxByKey.size === 0) {
        return;
    }
    const { favoriteFileIds } = deriveFavoriteFileIDs(
        userId,
        collections,
        files,
    );
    const filesById = new Map(files.map((file) => [file.id, file]));
    const verifiedKeys: string[] = [];
    for (const [key, entry] of outboxByKey) {
        const file = filesById.get(entry.fileId);
        if (!file) {
            continue;
        }
        const isFavorite = isFileFavorited(
            file,
            userId,
            collections,
            files,
        );
        const matchesId = favoriteFileIds.has(entry.fileId) === entry.isFavorite;
        if (isFavorite === entry.isFavorite || matchesId) {
            verifiedKeys.push(key);
        }
    }
    if (verifiedKeys.length > 0) {
        await removeFavoriteOutboxEntries(verifiedKeys);
    }
};

export const clearFavoriteOutbox = (): void => {
    outboxByKey.clear();
    hydrated = false;
    persistChain = Promise.resolve();
};
