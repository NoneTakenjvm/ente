import { sortFilesByUpload } from "@/lib/sort-files";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { decryptFileChanges } from "@/core/api/files";
import { getEnteCore } from "@/core";
import {
    getCollectionSyncTime,
    saveCollectionSyncTime,
} from "@/db/cursors";
import { loadEncryptedTrashItems, saveEncryptedFiles } from "@/db/kv";
import { invalidateThumbnailCache } from "@/lib/thumbnail-cache";
import { getSessionCacheKey } from "@/lib/cache-key";
import { removePhashEntry } from "@/lib/similarity-job";
import {
    applyFavoriteMembershipChanges,
    beginFavoriteMembershipFullSync,
    commitFavoriteMembershipSync,
    ensureFavoriteMembershipHydrated,
    needsFavoriteMembershipFullSync,
} from "@/lib/favorite-membership";
import { findUserFavoritesCollection } from "@/lib/favorites";
import {
    dedupeFilesById,
    didFileContentChange,
    mergeFavoritesCollectionIntoLibrary,
    mergeFileChangesIntoLibrary,
} from "@/lib/sync/merge-files";
import { applyOutboxTagsToFiles } from "@/lib/tag-outbox";
import { applyOutboxVisibilityToFiles } from "@/lib/visibility-outbox";

const collectionSyncConcurrency = 2;

export interface PullFilesOptions {
    collections: Collection[];
    files: EnteFile[];
    onProgress?: (current: number, total: number) => void;
}

export interface PullFilesResult {
    files: EnteFile[];
    didUpdate: boolean;
    /** True when favourite membership was re-committed (even with no changes). */
    favoritesMembershipTouched: boolean;
}

/**
 * Persist deferred per-collection cursors after the encrypted library snapshot,
 * removing each from {@link pendingCursors} once written.
 *
 * [Note: sync cursors after files] Advancing cursors before `saveEncryptedFiles`
 * left albums marked fully synced while the on-disk library stayed truncated.
 * The next open then early-skipped those albums until Force resync.
 *
 * @param heldCollectionId a collection whose cursor stays pending (the
 * Favourites collection, until its membership is committed).
 */
const commitPendingSyncCursors = async (
    pendingCursors: Map<number, number>,
    heldCollectionId?: number,
): Promise<void> => {
    for (const [collectionId, sinceTime] of pendingCursors) {
        if (collectionId === heldCollectionId) {
            continue;
        }
        await saveCollectionSyncTime(collectionId, sinceTime);
        pendingCursors.delete(collectionId);
    }
};

/** Persist the library snapshot, minus trashed files, with outbox overlays. */
const saveLibrarySnapshot = async (
    libraryById: ReadonlyMap<number, EnteFile>,
): Promise<void> => {
    const trashItems = await loadEncryptedTrashItems(getSessionCacheKey());
    const trashedIds = new Set((trashItems ?? []).map((item) => item.file.id));
    const forDisk = applyOutboxVisibilityToFiles(
        applyOutboxTagsToFiles(sortFilesByUpload([...libraryById.values()])),
    ).filter((file) => !trashedIds.has(file.id));
    await saveEncryptedFiles(forDisk, getSessionCacheKey());
};

const groupFilesByCollectionId = (
    libraryById: ReadonlyMap<number, EnteFile>,
): Map<number, Map<number, EnteFile>> => {
    const groups = new Map<number, Map<number, EnteFile>>();
    for (const file of libraryById.values()) {
        const group = groups.get(file.collectionID);
        if (group) {
            group.set(file.id, file);
        } else {
            groups.set(file.collectionID, new Map([[file.id, file]]));
        }
    }
    return groups;
};

/**
 * Incrementally pull file changes for all collections and persist encrypted snapshots.
 *
 * [Note: pull checkpoints] After each batch of collections the library is
 * saved and then that batch's cursors, so a kill mid-pull resumes from the
 * last finished batch. A cursor is never written before the files it covers.
 * The Favourites cursor waits for the membership commit at the end.
 */
export const pullFiles = async (
    options: PullFilesOptions,
): Promise<PullFilesResult> => {
    const { collections, onProgress } = options;
    let didUpdate = false;
    /** True while `libraryById` holds merges not yet saved to disk. */
    let hasUnsavedChanges = false;
    const libraryById = new Map(
        dedupeFilesById(options.files).map((file) => [file.id, file]),
    );
    /** Collection id → sinceTime; written only after encrypted files persist. */
    const pendingCursors = new Map<number, number>();

    await ensureFavoriteMembershipHydrated();
    const userId = getEnteCore().getUserID();
    const userFavorites = findUserFavoritesCollection(collections, userId);
    let favoritesMembershipTouched = false;

    if (!userFavorites) {
        // No Favourites album yet — empty membership is authoritative.
        await commitFavoriteMembershipSync();
    }

    const targets = collections;
    const total = targets.length;
    /**
     * Library grouped by collection, built once on the first collection that
     * needs a diff (one pass instead of a full scan per collection). Each
     * collection is pulled once, so its Map is owned by that pull.
     */
    let filesByCollectionId: Map<number, Map<number, EnteFile>> | undefined;

    for (let i = 0; i < targets.length; i += collectionSyncConcurrency) {
        const batch = targets.slice(i, i + collectionSyncConcurrency);
        await Promise.all(
            batch.map(async (collection, batchIndex) => {
                const index = i + batchIndex;
                onProgress?.(index + 1, total);

                const isUserFavorites = userFavorites?.id === collection.id;

                let sinceTime =
                    (await getCollectionSyncTime(collection.id)) ?? 0;
                const forceFavoritesFullSync =
                    isUserFavorites && needsFavoriteMembershipFullSync();
                if (forceFavoritesFullSync) {
                    sinceTime = 0;
                    beginFavoriteMembershipFullSync();
                }

                if (
                    !forceFavoritesFullSync &&
                    sinceTime === collection.updationTime
                ) {
                    return;
                }

                filesByCollectionId ??= groupFilesByCollectionId(libraryById);
                const collectionFilesById =
                    filesByCollectionId.get(collection.id) ??
                    new Map<number, EnteFile>();
                filesByCollectionId.set(collection.id, collectionFilesById);

                while (true) {
                    const { changes, hasMore } =
                        await getEnteCore().getCollectionFileDiff(
                            collection.id,
                            sinceTime,
                        );

                    if (!changes.length) {
                        break;
                    }

                    const decrypted = await decryptFileChanges(
                        changes,
                        collection.key,
                    );

                    for (const change of decrypted) {
                        sinceTime = Math.max(sinceTime, change.updationTime);
                        if (!change.isDeleted && change.file) {
                            const existing = collectionFilesById.get(change.id);
                            if (
                                didFileContentChange(existing, change.file)
                            ) {
                                await invalidateThumbnailCache(change.id);
                                await removePhashEntry(change.id);
                                void import("@/stores/phash-index-store").then(
                                    ({ usePhashIndexStore }) => {
                                        const { entries, setEntries } =
                                            usePhashIndexStore.getState();
                                        if (entries.has(change.id)) {
                                            const next = new Map(entries);
                                            next.delete(change.id);
                                            setEntries(next);
                                        }
                                    },
                                );
                            }
                        }
                    }

                    if (isUserFavorites) {
                        applyFavoriteMembershipChanges(decrypted);
                        mergeFavoritesCollectionIntoLibrary(
                            libraryById,
                            decrypted,
                        );
                        favoritesMembershipTouched = true;
                    } else {
                        mergeFileChangesIntoLibrary(
                            libraryById,
                            collection.id,
                            collectionFilesById,
                            decrypted,
                            filesByCollectionId,
                        );
                    }

                    pendingCursors.set(collection.id, sinceTime);
                    didUpdate = true;
                    hasUnsavedChanges = true;

                    if (!hasMore) {
                        break;
                    }
                }

                pendingCursors.set(collection.id, collection.updationTime);
                if (isUserFavorites) {
                    favoritesMembershipTouched = true;
                }
            }),
        );
        // Checkpoint: files first, then the cursors they cover.
        if (hasUnsavedChanges) {
            await saveLibrarySnapshot(libraryById);
            hasUnsavedChanges = false;
        }
        await commitPendingSyncCursors(pendingCursors, userFavorites?.id);
    }

    if (userFavorites && favoritesMembershipTouched) {
        await commitFavoriteMembershipSync();
    }

    if (hasUnsavedChanges) {
        await saveLibrarySnapshot(libraryById);
    }
    await commitPendingSyncCursors(pendingCursors);

    return {
        files: sortFilesByUpload([...libraryById.values()]),
        didUpdate,
        favoritesMembershipTouched,
    };
};
