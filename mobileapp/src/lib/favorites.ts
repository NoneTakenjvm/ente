import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { metadataHash } from "ente-media/file-metadata";
import {
    getFavoriteMembershipIds,
    isFavoriteMembershipReady,
} from "@/lib/favorite-membership";

export type UnsyncedFavoriteUpdateKey = number | string;

export interface UnsyncedFavoriteUpdate {
    fileID: number;
    fileHashAndTypeKey?: string;
    isFavorite: boolean;
}

/**
 * Composite key `${metadataHash}:${fileType}` for content-equivalent files.
 */
export const hashAndTypeKey = (file: EnteFile): string | undefined => {
    const hash = metadataHash(file.metadata);
    if (!hash) {
        return undefined;
    }
    return `${hash}:${file.metadata.fileType}`;
};

/**
 * Map user-owned files by hash/type key (first match wins).
 */
export const userOwnedEquivalentFilesByHashAndType = (
    files: EnteFile[],
    userId: number,
): Map<string, EnteFile> => {
    const equivalents = new Map<string, EnteFile>();
    for (const file of files) {
        if (file.ownerID !== userId) {
            continue;
        }
        const key = hashAndTypeKey(file);
        if (!key || equivalents.has(key)) {
            continue;
        }
        equivalents.set(key, file);
    }
    return equivalents;
};

/**
 * Return the user's own favourites collection, if present.
 */
export const findUserFavoritesCollection = (
    collections: Collection[],
    userId: number,
): Collection | undefined =>
    collections.find(
        (collection) =>
            collection.type === "favorites" && collection.owner.id === userId,
    );

const unsyncedUpdateKey = (
    file: EnteFile,
    userId: number,
): UnsyncedFavoriteUpdateKey => {
    if (file.ownerID !== userId) {
        const key = hashAndTypeKey(file);
        if (key) {
            return key;
        }
    }
    return file.id;
};

/**
 * Merge in-memory and outbox favourite intents, dropping those the library
 * snapshot already confirms.
 */
export const mergePendingFavoriteUpdates = (
    existing: Map<UnsyncedFavoriteUpdateKey, UnsyncedFavoriteUpdate>,
    fromOutbox: Map<UnsyncedFavoriteUpdateKey, UnsyncedFavoriteUpdate>,
    confirmedFavoriteIds: Set<number>,
): Map<UnsyncedFavoriteUpdateKey, UnsyncedFavoriteUpdate> => {
    const merged = new Map(existing);
    for (const [key, update] of fromOutbox) {
        merged.set(key, update);
    }
    for (const [key, update] of merged) {
        if (confirmedFavoriteIds.has(update.fileID) === update.isFavorite) {
            merged.delete(key);
        }
    }
    return merged;
};

/**
 * File IDs touched by one unsynced favourite intent.
 *
 * Owned files: just {@link UnsyncedFavoriteUpdate.fileID}. Shared files keyed
 * by hash: every non-owned library row with that hash/type (may scan
 * {@link allFiles}).
 */
export const fileIdsForFavoriteUpdate = (
    update: UnsyncedFavoriteUpdate,
    userId: number,
    allFiles: EnteFile[],
): number[] => {
    if (!update.fileHashAndTypeKey) {
        return [update.fileID];
    }
    const ids: number[] = [];
    for (const file of allFiles) {
        if (file.ownerID === userId) {
            continue;
        }
        if (hashAndTypeKey(file) === update.fileHashAndTypeKey) {
            ids.push(file.id);
        }
    }
    return ids.length > 0 ? ids : [update.fileID];
};

/**
 * Patch an existing favourite-id set for one unsynced intent (no full-library
 * baseline rebuild). Owned toggles are O(1); shared hash toggles scan once.
 */
export const applyFavoriteUpdateToIds = (
    favoriteFileIds: Set<number>,
    update: UnsyncedFavoriteUpdate,
    userId: number,
    allFiles: EnteFile[],
): Set<number> => {
    const next = new Set(favoriteFileIds);
    for (const fileID of fileIdsForFavoriteUpdate(update, userId, allFiles)) {
        if (update.isFavorite) {
            next.add(fileID);
        } else {
            next.delete(fileID);
        }
    }
    return next;
};

export interface DeriveFavoriteFileIDsOptions {
    /**
     * File IDs in the user's Favourites collection on remote. When omitted,
     * reads the hydrated membership oracle.
     */
    membershipFileIds?: Set<number>;
    /**
     * When false, also treat `collectionID === favorites` as a hint (pre-sync
     * bootstrap). Defaults to {@link isFavoriteMembershipReady}.
     */
    membershipReady?: boolean;
}

/**
 * Compute favourite file IDs from server membership plus optimistic overlays.
 *
 * [Note: Favourite membership vs library collectionID] Baseline membership is
 * the Favourites collection file-id set, not `file.collectionID` on the
 * id-deduped library. Shared (non-owned) gallery rows are marked favourite when
 * their hash/type matches a membership file — same as the official app.
 */
export const deriveFavoriteFileIDs = (
    userId: number,
    collections: Collection[],
    allFiles: EnteFile[],
    unsyncedFavoriteUpdates: Map<
        UnsyncedFavoriteUpdateKey,
        UnsyncedFavoriteUpdate
    > = new Map(),
    options?: DeriveFavoriteFileIDsOptions,
): { favoritesCollectionId: number | null; favoriteFileIds: Set<number> } => {
    const favoritesCollection = findUserFavoritesCollection(
        collections,
        userId,
    );
    if (!favoritesCollection) {
        return { favoritesCollectionId: null, favoriteFileIds: new Set() };
    }

    const membershipFileIds =
        options?.membershipFileIds ?? getFavoriteMembershipIds();
    const membershipReady =
        options?.membershipReady ?? isFavoriteMembershipReady();

    const favoriteFileIds = new Set(membershipFileIds);

    // Until the membership oracle has synced once, keep any library rows that
    // still carry Favorites as collectionID so stars do not all vanish mid-pull.
    if (!membershipReady) {
        for (const file of allFiles) {
            if (file.collectionID === favoritesCollection.id) {
                favoriteFileIds.add(file.id);
            }
        }
    }

    const favoriteFileHashAndTypeKeys = new Set<string>();
    const filesById = new Map(allFiles.map((file) => [file.id, file]));
    for (const membershipId of favoriteFileIds) {
        const membershipFile = filesById.get(membershipId);
        if (!membershipFile) {
            continue;
        }
        const key = hashAndTypeKey(membershipFile);
        if (key) {
            favoriteFileHashAndTypeKeys.add(key);
        }
    }
    // Membership ids may not be in the deduped library (same id, other album).
    // Hash keys for those come only when we have a library row; shared matching
    // still works once the owned favourite copy is present in allFiles under
    // any collectionID, or when optimistic updates carry hash keys.

    for (const file of allFiles) {
        if (file.ownerID === userId) {
            continue;
        }
        const key = hashAndTypeKey(file);
        if (key && favoriteFileHashAndTypeKeys.has(key)) {
            favoriteFileIds.add(file.id);
        }
    }

    // Also mark owned library rows whose id is in membership (explicit).
    // Already covered by favoriteFileIds = Set(membershipFileIds).

    for (const update of unsyncedFavoriteUpdates.values()) {
        for (const fileID of fileIdsForFavoriteUpdate(
            update,
            userId,
            allFiles,
        )) {
            if (update.isFavorite) {
                favoriteFileIds.add(fileID);
            } else {
                favoriteFileIds.delete(fileID);
            }
        }
    }

    return {
        favoritesCollectionId: favoritesCollection.id,
        favoriteFileIds,
    };
};

/**
 * Return true when a library file is currently marked as a favourite.
 */
export const isFileFavorited = (
    file: EnteFile,
    userId: number,
    collections: Collection[],
    allFiles: EnteFile[],
    unsyncedFavoriteUpdates: Map<
        UnsyncedFavoriteUpdateKey,
        UnsyncedFavoriteUpdate
    > = new Map(),
    options?: DeriveFavoriteFileIDsOptions,
): boolean =>
    deriveFavoriteFileIDs(
        userId,
        collections,
        allFiles,
        unsyncedFavoriteUpdates,
        options,
    ).favoriteFileIds.has(file.id);

export const createUnsyncedFavoriteUpdate = (
    file: EnteFile,
    userId: number,
    isFavorite: boolean,
): { key: UnsyncedFavoriteUpdateKey; update: UnsyncedFavoriteUpdate } => {
    const fileHashAndTypeKey =
        file.ownerID !== userId ? hashAndTypeKey(file) : undefined;
    return {
        key: unsyncedUpdateKey(file, userId),
        update: {
            fileID: file.id,
            fileHashAndTypeKey,
            isFavorite,
        },
    };
};

export const filterFavoriteCollectionFiles = (
    allFiles: EnteFile[],
    favoritesCollectionId: number | null,
): EnteFile[] => {
    if (favoritesCollectionId === null) {
        return [];
    }
    return allFiles.filter(
        (file) => file.collectionID === favoritesCollectionId,
    );
};
