import type { Collection } from "ente-media/collection";
import { ItemVisibility } from "ente-media/file-metadata";

/**
 * Return true when the collection is hidden for the given user.
 */
export const isHiddenCollection = (
    collection: Collection,
    userId: number,
): boolean => {
    if (collection.owner.id === userId) {
        return (
            collection.magicMetadata?.data.visibility === ItemVisibility.hidden
        );
    }
    return (
        collection.sharedMagicMetadata?.data.visibility ===
        ItemVisibility.hidden
    );
};

/**
 * User-owned collections that are not hidden.
 */
export const normalOwnedCollections = (
    collections: Collection[],
    userId: number,
): Collection[] =>
    collections.filter(
        (collection) =>
            collection.owner.id === userId &&
            !isHiddenCollection(collection, userId),
    );

export const collectionNameByID = (
    collections: Collection[],
): Map<number, string> => new Map(collections.map((c) => [c.id, c.name]));
