import {
    mergeCollectionChanges,
    type CollectionChange,
} from "@/core/api/collections";
import { getEnteCore } from "@/core";
import {
    getCollectionsUpdationTime,
    removeCollectionSyncTime,
    saveCollectionsUpdationTime,
} from "@/db/cursors";
import { saveEncryptedCollections } from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";
import type { Collection } from "ente-media/collection";

export interface PullCollectionsResult {
    collections: Collection[];
    didUpdate: boolean;
}

/**
 * Incrementally pull collection list changes and persist encrypted snapshot.
 */
export const pullCollections = async (
    existing: Collection[],
): Promise<PullCollectionsResult> => {
    const core = getEnteCore();
    let sinceTime = (await getCollectionsUpdationTime()) ?? 0;
    const changes: CollectionChange[] =
        await core.getCollectionChanges(sinceTime);

    if (!changes.length) {
        return { collections: existing, didUpdate: false };
    }

    const collections = mergeCollectionChanges(existing, changes);

    for (const change of changes) {
        sinceTime = Math.max(sinceTime, change.updationTime);
        if (change.isDeleted) {
            await removeCollectionSyncTime(change.id);
        }
    }

    const cacheKey = getSessionCacheKey();
    await saveEncryptedCollections(collections, cacheKey);
    await saveCollectionsUpdationTime(sinceTime);

    return { collections, didUpdate: true };
};
