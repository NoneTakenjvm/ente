import { getEnteCore } from "@/core";
import { getTrashDiff } from "@/core/api/trash";
import {
    getTrashLastUpdatedAt,
    saveTrashLastUpdatedAt,
} from "@/db/cursors";
import { getSessionCacheKey } from "@/lib/cache-key";
import {
    loadEncryptedTrashCollectionKeys,
    loadEncryptedTrashItems,
    saveEncryptedTrashCollectionKeys,
    saveEncryptedTrashItems,
    type PersistedTrashCollectionKey,
    type PersistedTrashItem,
} from "@/db/kv";
import type { Collection } from "ente-media/collection";
import { decryptRemoteFile } from "ente-media/file";

export type TrashItem = PersistedTrashItem;

export interface PullTrashResult {
    items: TrashItem[];
    permanentlyDeletedFileIds: number[];
    lastUpdatedAt: number;
}

/**
 * Pull trash changes from remote, decrypt, and persist encrypted locally.
 *
 * Collections may already be deleted while trash still references them — we
 * fetch those keys on demand and keep them in the trash collection-key list.
 */
export const pullTrash = async (
    collections: Collection[],
): Promise<PullTrashResult> => {
    const core = getEnteCore();
    const http = core.getHttpClient();
    const cacheKey = getSessionCacheKey();

    const collectionKeyByID = new Map(
        collections.map((collection) => [collection.id, collection.key]),
    );
    const trashItemCollectionKeys =
        (await loadEncryptedTrashCollectionKeys(cacheKey)) ?? [];
    for (const { id, key } of trashItemCollectionKeys) {
        collectionKeyByID.set(id, key);
    }

    const trashItemsByID = new Map(
        ((await loadEncryptedTrashItems(cacheKey)) ?? []).map((item) => [
            item.file.id,
            item,
        ]),
    );
    let sinceTime = (await getTrashLastUpdatedAt()) ?? 0;
    const permanentlyDeletedFileIds: number[] = [];
    /** File IDs removed from trash this pull (restored or permanently deleted). */
    const removedFromTrashIds = new Set<number>();

    for (;;) {
        const { diff, hasMore } = await getTrashDiff(http, sinceTime);
        if (!diff.length) {
            break;
        }

        for (const change of diff) {
            sinceTime = Math.max(sinceTime, change.updatedAt);
            const fileID = change.file.id;
            if (change.isDeleted) {
                permanentlyDeletedFileIds.push(fileID);
            }
            if (change.isDeleted || change.isRestored) {
                trashItemsByID.delete(fileID);
                removedFromTrashIds.add(fileID);
                continue;
            }

            let collectionKey = collectionKeyByID.get(
                change.file.collectionID,
            );
            if (!collectionKey) {
                const collection = await core.getCollectionByID(
                    change.file.collectionID,
                );
                collectionKey = collection.key;
                collectionKeyByID.set(collection.id, collectionKey);
                trashItemCollectionKeys.push({
                    id: collection.id,
                    key: collectionKey,
                });
                await saveEncryptedTrashCollectionKeys(
                    trashItemCollectionKeys,
                    cacheKey,
                );
            }

            trashItemsByID.set(fileID, {
                file: await decryptRemoteFile(change.file, collectionKey),
                updatedAt: change.updatedAt,
                deleteBy: change.deleteBy,
            });
        }

        const items = [...trashItemsByID.values()];
        await saveEncryptedTrashItems(items, cacheKey);
        await saveTrashLastUpdatedAt(sinceTime);
        if (!hasMore) {
            break;
        }
    }

    // Preserve optimistic seeds written while this pull was in flight — a
    // concurrent seed would otherwise be wiped by the final IDB write.
    const latestLocal = (await loadEncryptedTrashItems(cacheKey)) ?? [];
    for (const item of latestLocal) {
        if (
            removedFromTrashIds.has(item.file.id) ||
            trashItemsByID.has(item.file.id)
        ) {
            continue;
        }
        trashItemsByID.set(item.file.id, item);
    }

    const items = [...trashItemsByID.values()];
    const trashCollectionIDs = new Set(
        items.map((item) => item.file.collectionID),
    );
    const prunedKeys: PersistedTrashCollectionKey[] = [
        ...collectionKeyByID.entries(),
    ]
        .filter(([id]) => trashCollectionIDs.has(id))
        .map(([id, key]) => ({ id, key }));
    await saveEncryptedTrashCollectionKeys(prunedKeys, cacheKey);
    await saveEncryptedTrashItems(items, cacheKey);
    await saveTrashLastUpdatedAt(sinceTime);

    return {
        items,
        permanentlyDeletedFileIds,
        lastUpdatedAt: sinceTime,
    };
};
