import { metadataHash } from "ente-media/file-metadata";
import type { EnteFile } from "ente-media/file";
import type { CollectionFileChange } from "@/core/api/files";

/**
 * Apply collection file diff changes to a deduped library map.
 */
export const mergeFileChangesIntoLibrary = (
    libraryById: Map<number, EnteFile>,
    collectionId: number,
    collectionFilesById: Map<number, EnteFile>,
    changes: CollectionFileChange[],
): Map<number, EnteFile> => {
    for (const change of changes) {
        if (change.isDeleted) {
            collectionFilesById.delete(change.id);
            const existing = libraryById.get(change.id);
            if (existing?.collectionID === collectionId) {
                libraryById.delete(change.id);
            }
            continue;
        }
        if (!change.file) {
            continue;
        }
        collectionFilesById.set(change.id, change.file);
        libraryById.set(change.id, change.file);
    }
    return libraryById;
};

/**
 * Merge Favourites collection diffs without stealing the library row's
 * `collectionID` or deleting the file when unfavourited.
 *
 * [Note: Favourite membership vs library collectionID] Favourites are tracked
 * in {@link applyFavoriteMembershipChanges}; the library stays keyed by file
 * id for gallery/albums.
 */
export const mergeFavoritesCollectionIntoLibrary = (
    libraryById: Map<number, EnteFile>,
    changes: CollectionFileChange[],
): void => {
    for (const change of changes) {
        if (change.isDeleted) {
            continue;
        }
        if (!change.file) {
            continue;
        }
        if (!libraryById.has(change.id)) {
            libraryById.set(change.id, change.file);
        }
    }
};

/**
 * Return true when thumbnail cache should be invalidated for a file update.
 */
export const didFileContentChange = (
    existing: EnteFile | undefined,
    updated: EnteFile,
): boolean => {
    if (!existing) {
        return false;
    }
    return metadataHash(existing.metadata) !== metadataHash(updated.metadata);
};

export const dedupeFilesById = (files: EnteFile[]): EnteFile[] => {
    const byId = new Map<number, EnteFile>();
    for (const file of files) {
        byId.set(file.id, file);
    }
    return [...byId.values()];
};

export const filterFilesForCollection = (
    files: EnteFile[],
    collectionId: number | null,
): EnteFile[] => {
    if (collectionId === null) {
        return dedupeFilesById(files);
    }
    return files.filter((file) => file.collectionID === collectionId);
};
