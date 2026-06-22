import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { metadataHash } from "ente-media/file-metadata";

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
 * Compute favourite file IDs from synced library state plus optimistic overrides.
 */
export const deriveFavoriteFileIDs = (
    userId: number,
    collections: Collection[],
    allFiles: EnteFile[],
    unsyncedFavoriteUpdates: Map<
        UnsyncedFavoriteUpdateKey,
        UnsyncedFavoriteUpdate
    > = new Map(),
): { favoritesCollectionId: number | null; favoriteFileIds: Set<number> } => {
    const favoritesCollection = findUserFavoritesCollection(
        collections,
        userId,
    );
    if (!favoritesCollection) {
        return { favoritesCollectionId: null, favoriteFileIds: new Set() };
    }

    const favoriteFiles = allFiles.filter(
        (file) => file.collectionID === favoritesCollection.id,
    );
    const favoriteFileIds = new Set(favoriteFiles.map((file) => file.id));
    const favoriteFileHashAndTypeKeys = new Set(
        favoriteFiles.flatMap((file) => {
            const key = hashAndTypeKey(file);
            return key ? [key] : [];
        }),
    );

    for (const file of allFiles) {
        if (file.ownerID === userId) {
            continue;
        }
        const key = hashAndTypeKey(file);
        if (key && favoriteFileHashAndTypeKeys.has(key)) {
            favoriteFileIds.add(file.id);
        }
    }

    for (const update of unsyncedFavoriteUpdates.values()) {
        const updatedFileIDs = update.fileHashAndTypeKey ?
            allFiles
                .filter(
                    (file) =>
                        file.ownerID !== userId &&
                          hashAndTypeKey(file) === update.fileHashAndTypeKey,
                )
                .map((file) => file.id) :
            [update.fileID];
        for (const fileID of updatedFileIDs) {
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
