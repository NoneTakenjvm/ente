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
    dedupeFilesById,
    didFileContentChange,
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
}

/**
 * Persist deferred per-collection cursors after the encrypted library snapshot.
 *
 * [Note: sync cursors after files] Advancing cursors before `saveEncryptedFiles`
 * left albums marked fully synced while the on-disk library stayed truncated.
 * The next open then early-skipped those albums until Force resync.
 */
const commitPendingSyncCursors = async (
    pendingCursors: Map<number, number>,
): Promise<void> => {
    for (const [collectionId, sinceTime] of pendingCursors) {
        await saveCollectionSyncTime(collectionId, sinceTime);
    }
};

/**
 * Incrementally pull file changes for all collections and persist encrypted snapshots.
 */
export const pullFiles = async (
    options: PullFilesOptions,
): Promise<PullFilesResult> => {
    const { collections, onProgress } = options;
    let didUpdate = false;
    const libraryById = new Map(
        dedupeFilesById(options.files).map((file) => [file.id, file]),
    );
    /** Collection id → sinceTime; written only after encrypted files persist. */
    const pendingCursors = new Map<number, number>();

    const targets = collections;
    const total = targets.length;

    for (let i = 0; i < targets.length; i += collectionSyncConcurrency) {
        const batch = targets.slice(i, i + collectionSyncConcurrency);
        await Promise.all(
            batch.map(async (collection, batchIndex) => {
                const index = i + batchIndex;
                onProgress?.(index + 1, total);

                let sinceTime =
                    (await getCollectionSyncTime(collection.id)) ?? 0;
                if (sinceTime === collection.updationTime) {
                    return;
                }

                const collectionFilesById = new Map(
                    [...libraryById.values()]
                        .filter((file) => file.collectionID === collection.id)
                        .map((file) => [file.id, file]),
                );

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

                    mergeFileChangesIntoLibrary(
                        libraryById,
                        collection.id,
                        collectionFilesById,
                        decrypted,
                    );

                    pendingCursors.set(collection.id, sinceTime);
                    didUpdate = true;

                    if (!hasMore) {
                        break;
                    }
                }

                pendingCursors.set(collection.id, collection.updationTime);
            }),
        );
    }

    const files = sortFilesByUpload([...libraryById.values()]);
    if (didUpdate) {
        const trashItems = await loadEncryptedTrashItems(getSessionCacheKey());
        const trashedIds = new Set(
            (trashItems ?? []).map((item) => item.file.id),
        );
        const forDisk = applyOutboxVisibilityToFiles(
            applyOutboxTagsToFiles(files),
        ).filter((file) => !trashedIds.has(file.id));
        await saveEncryptedFiles(forDisk, getSessionCacheKey());
    }
    // Cursors only after a durable library snapshot (or when no file changes).
    await commitPendingSyncCursors(pendingCursors);

    return {
        files,
        didUpdate,
    };
};
