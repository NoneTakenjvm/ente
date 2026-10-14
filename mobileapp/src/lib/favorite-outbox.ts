import type { EnteFile } from "ente-media/file";
import type { Collection } from "ente-media/collection";
import { hashAndTypeKey } from "@/core/api/collection-files";
import {
    deriveFavoriteFileIDs,
    type UnsyncedFavoriteUpdate,
    type UnsyncedFavoriteUpdateKey,
} from "@/lib/favorites";
import { createOutbox } from "@/lib/outbox";

export interface FavoriteOutboxEntry {
    fileId: number;
    isFavorite: boolean;
    fileHashAndTypeKey?: string;
    enqueuedAt: number;
}

export const favoriteOutboxEntryKey = (entry: FavoriteOutboxEntry): string =>
    entry.fileHashAndTypeKey ?? String(entry.fileId);

const outbox = createOutbox<FavoriteOutboxEntry, string>({
    kvKey: "favoriteOutbox",
    keyOf: favoriteOutboxEntryKey,
    label: "Favourite outbox",
    sameIntent: (current, sent) => current.isFavorite === sent.isFavorite,
});

/**
 * Load the encrypted favourite outbox from IndexedDB into memory.
 */
export const hydrateFavoriteOutbox = outbox.hydrate;

export const ensureFavoriteOutboxHydrated = outbox.hydrate;

export const isFavoriteOutboxHydrated = outbox.isHydrated;

/**
 * Persist the in-memory outbox to encrypted IDB (page hide / before unload).
 */
export const flushFavoriteOutboxPersist = outbox.flush;

/**
 * Queue or replace a pending favourite mutation for a file.
 */
export const upsertFavoriteOutboxEntry = async (
    file: EnteFile,
    userId: number,
    isFavorite: boolean,
): Promise<void> => {
    const fileHashAndTypeKey =
        file.ownerID !== userId ? hashAndTypeKey(file) : undefined;
    await outbox.upsert([
        {
            fileId: file.id,
            isFavorite,
            fileHashAndTypeKey: fileHashAndTypeKey ?? undefined,
            enqueuedAt: Date.now(),
        },
    ]);
};

/**
 * Remove each entry in `sent` only if it is still the entry that was sent, so
 * a newer favourite intent queued mid-flight survives the ack.
 */
export const removeFavoriteOutboxEntriesIfUnchanged = outbox.removeIfUnchanged;

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
    await outbox.removeWhere((entry) => idSet.has(entry.fileId));
};

export const getFavoriteOutboxEntries = outbox.entries;

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
    for (const entry of outbox.entries()) {
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
export const remapFavoriteOutboxFileId = (
    fromFileId: number,
    toFileId: number,
): Promise<void> =>
    outbox.remap(String(fromFileId), String(toFileId), (entry) => ({
        ...entry,
        fileId: toFileId,
    }));

/**
 * Drop outbox entries whose synced library already matches intent.
 */
export const reconcileFavoriteOutboxWithLibrary = async (
    userId: number,
    collections: Collection[],
    files: EnteFile[],
): Promise<void> => {
    if (outbox.size() === 0) {
        return;
    }
    const { favoriteFileIds } = deriveFavoriteFileIDs(
        userId,
        collections,
        files,
    );
    const fileIds = new Set(files.map((file) => file.id));
    const verifiedKeys = new Set<string>();
    for (const entry of outbox.entries()) {
        if (
            fileIds.has(entry.fileId) &&
            favoriteFileIds.has(entry.fileId) === entry.isFavorite
        ) {
            verifiedKeys.add(favoriteOutboxEntryKey(entry));
        }
    }
    await outbox.removeWhere((entry) =>
        verifiedKeys.has(favoriteOutboxEntryKey(entry)));
};

export const clearFavoriteOutbox = outbox.clear;
