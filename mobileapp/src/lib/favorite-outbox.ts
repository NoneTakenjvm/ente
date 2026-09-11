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
    type UnsyncedFavoriteUpdate,
    type UnsyncedFavoriteUpdateKey,
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
let favoriteOutboxHydrateInFlight: Promise<void> | undefined;

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
    persistChain = persistChain
        .catch(() => undefined)
        .then(() => flushFavoriteOutboxToDisk())
        .catch((error: unknown) => {
            console.warn("Favourite outbox persist failed", error);
        });
    return persistChain;
};

/**
 * Load the encrypted favourite outbox from IndexedDB into memory.
 */
export const hydrateFavoriteOutbox = async (): Promise<void> => {
    if (hydrated) {
        return;
    }
    if (favoriteOutboxHydrateInFlight) {
        return favoriteOutboxHydrateInFlight;
    }
    favoriteOutboxHydrateInFlight = (async () => {
        const persisted = await loadEncryptedFavoriteOutbox(getSessionCacheKey());
        outboxByKey.clear();
        for (const entry of persisted ?? []) {
            outboxByKey.set(entryKey(entry), entry);
        }
        hydrated = true;
    })().finally(() => {
        favoriteOutboxHydrateInFlight = undefined;
    });
    return favoriteOutboxHydrateInFlight;
};

export const ensureFavoriteOutboxHydrated = async (): Promise<void> => {
    if (hydrated) {
        return;
    }
    await hydrateFavoriteOutbox();
};

export const isFavoriteOutboxHydrated = (): boolean => hydrated;

/**
 * Persist the in-memory outbox to encrypted IDB (page hide / before unload).
 */
export const flushFavoriteOutboxPersist = (): Promise<void> => {
    if (!hydrated) {
        return ensureFavoriteOutboxHydrated().then(() => persistFavoriteOutbox());
    }
    return persistFavoriteOutbox();
};

/**
 * Queue or replace a pending favourite mutation for a file.
 */
export const upsertFavoriteOutboxEntry = async (
    file: EnteFile,
    userId: number,
    isFavorite: boolean,
): Promise<void> => {
    if (!hydrated) {
        await ensureFavoriteOutboxHydrated();
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

/**
 * Drop pending favourite intents for files that were moved to trash.
 */
export const removeFavoriteOutboxForFileIds = async (
    fileIds: number[],
): Promise<void> => {
    if (!fileIds.length) {
        return;
    }
    const idSet = new Set(fileIds);
    const keys: string[] = [];
    for (const [key, entry] of outboxByKey) {
        if (idSet.has(entry.fileId)) {
            keys.push(key);
        }
    }
    await removeFavoriteOutboxEntries(keys);
};

export const getFavoriteOutboxEntries = (): FavoriteOutboxEntry[] =>
    [...outboxByKey.values()];

/**
 * Pending favourite intents as unsynced store updates (for overlay after sync).
 */
export const unsyncedUpdatesFromFavoriteOutbox = (): Map<
    UnsyncedFavoriteUpdateKey,
    UnsyncedFavoriteUpdate
> => {
    const updates = new Map<
        UnsyncedFavoriteUpdateKey,
        UnsyncedFavoriteUpdate
    >();
    for (const entry of outboxByKey.values()) {
        const key = entry.fileHashAndTypeKey ?? entry.fileId;
        updates.set(key, {
            fileID: entry.fileId,
            fileHashAndTypeKey: entry.fileHashAndTypeKey,
            isFavorite: entry.isFavorite,
        });
    }
    return updates;
};

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
    favoriteOutboxHydrateInFlight = undefined;
    persistChain = Promise.resolve();
};

if (typeof window !== "undefined") {
    const flushOnHide = (): void => {
        void flushFavoriteOutboxPersist();
    };
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            flushOnHide();
        }
    });
    // Tab-close warn for any outbox: installDurableFlushListeners in durable-flush.ts.
}
