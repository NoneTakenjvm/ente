import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import {
    addOrCopyToCollection,
    addToCollection,
    removeFromOwnCollection,
    type CollectionFilesContext,
} from "./collection-files";
import { createRemoteCollection } from "./collections";
import type { HttpClient } from "./http";
import {
    findUserFavoritesCollection,
    hashAndTypeKey,
    userOwnedEquivalentFilesByHashAndType,
} from "@/lib/favorites";
import type { CoreSession } from "../session";

const favoritesCollectionName = "Favorites";

export interface FavoritesContext {
    http: HttpClient;
    session: CoreSession;
    userId: number;
    collections: Collection[];
    allFiles: EnteFile[];
    pendingByHashAndType: Map<string, EnteFile>;
}

const toCollectionFilesContext = (
    ctx: FavoritesContext,
): CollectionFilesContext => ({
    http: ctx.http,
    session: ctx.session,
    userId: ctx.userId,
    collections: ctx.collections,
    allFiles: ctx.allFiles,
});

const uniqueFilesByID = (files: EnteFile[]): EnteFile[] => {
    const seen = new Set<number>();
    const uniqueFiles: EnteFile[] = [];
    for (const file of files) {
        if (seen.has(file.id)) {
            continue;
        }
        seen.add(file.id);
        uniqueFiles.push(file);
    }
    return uniqueFiles;
};

const rememberPendingFavoriteFiles = (
    sourceFiles: EnteFile[],
    favoriteFiles: EnteFile[],
    userId: number,
    pendingByHashAndType: Map<string, EnteFile>,
): void => {
    const favoriteFilesByHashAndType = userOwnedEquivalentFilesByHashAndType(
        favoriteFiles,
        userId,
    );
    for (const sourceFile of sourceFiles) {
        const hashAndType = hashAndTypeKey(sourceFile);
        const favoriteFile = hashAndType ?
            favoriteFilesByHashAndType.get(hashAndType) :
            undefined;
        if (hashAndType && favoriteFile) {
            pendingByHashAndType.set(hashAndType, favoriteFile);
        }
    }
};

const splitPendingFavoriteFiles = (
    files: EnteFile[],
    userId: number,
    pendingByHashAndType: Map<string, EnteFile>,
): { pendingFiles: EnteFile[]; remainingFiles: EnteFile[] } => {
    const pendingFiles: EnteFile[] = [];
    const remainingFiles: EnteFile[] = [];
    const seenPendingFileIDs = new Set<number>();

    for (const file of files) {
        if (file.ownerID === userId) {
            remainingFiles.push(file);
            continue;
        }

        const key = hashAndTypeKey(file);
        const pendingFavoriteFile = key ?
            pendingByHashAndType.get(key) :
            undefined;

        if (pendingFavoriteFile) {
            if (!seenPendingFileIDs.has(pendingFavoriteFile.id)) {
                seenPendingFileIDs.add(pendingFavoriteFile.id);
                pendingFiles.push(pendingFavoriteFile);
            }
        } else {
            remainingFiles.push(file);
        }
    }

    return { pendingFiles, remainingFiles };
};

const resolveFavoritesFilesForRemoval = (
    ctx: FavoritesContext,
    favoritesCollection: Collection,
    files: EnteFile[],
): EnteFile[] => {
    const { userId, allFiles, pendingByHashAndType } = ctx;
    const favoriteFilesByHashAndType = userOwnedEquivalentFilesByHashAndType(
        allFiles.filter((file) => file.collectionID === favoritesCollection.id),
        userId,
    );

    return files.map((file) => {
        if (
            file.ownerID !== userId &&
            file.collectionID !== favoritesCollection.id
        ) {
            const key = hashAndTypeKey(file);
            const favoriteFile = key ?
                (favoriteFilesByHashAndType.get(key) ??
                  pendingByHashAndType.get(key)) :
                undefined;
            if (!favoriteFile) {
                throw new Error("Could not resolve favorite file for removal");
            }
            return favoriteFile;
        }
        return file;
    });
};

const createFavoritesCollection = async (
    ctx: FavoritesContext,
): Promise<Collection> =>
    createRemoteCollection(
        ctx.http,
        ctx.session,
        favoritesCollectionName,
        "favorites",
    );

const savedOrCreateUserFavoritesCollection = async (
    ctx: FavoritesContext,
): Promise<Collection> =>
    findUserFavoritesCollection(ctx.collections, ctx.userId) ??
    createFavoritesCollection(ctx);

/**
 * Mark files as favourites by adding them to the user's favourites collection.
 *
 * @returns File IDs that are now members of the Favourites collection on remote.
 */
export const addToFavoritesCollection = async (
    ctx: FavoritesContext,
    files: EnteFile[],
): Promise<number[]> => {
    const { userId, pendingByHashAndType } = ctx;

    const hashlessSharedFile = files.find(
        (file) => file.ownerID !== userId && !hashAndTypeKey(file),
    );
    if (hashlessSharedFile) {
        throw new Error("Cannot favorite shared files without metadata hash");
    }

    const favoritesCollection = await savedOrCreateUserFavoritesCollection(ctx);
    const collectionCtx = toCollectionFilesContext(ctx);
    const { pendingFiles, remainingFiles } = splitPendingFavoriteFiles(
        files,
        userId,
        pendingByHashAndType,
    );

    const addedFiles: EnteFile[] = [];

    if (pendingFiles.length) {
        await addToCollection(collectionCtx, favoritesCollection, pendingFiles);
        addedFiles.push(...pendingFiles);
    }

    if (remainingFiles.length) {
        const copiedOrAdded = await addOrCopyToCollection(
            collectionCtx,
            favoritesCollection,
            remainingFiles,
        );
        addedFiles.push(...copiedOrAdded);
    }

    rememberPendingFavoriteFiles(
        files,
        addedFiles,
        userId,
        pendingByHashAndType,
    );

    return uniqueFilesByID(addedFiles).map((file) => file.id);
};

/**
 * Remove files from the user's favourites collection.
 *
 * @returns File IDs removed from Favourites membership on remote.
 */
export const removeFromFavoritesCollection = async (
    ctx: FavoritesContext,
    files: EnteFile[],
): Promise<number[]> => {
    const favoritesCollection = findUserFavoritesCollection(
        ctx.collections,
        ctx.userId,
    );
    if (!favoritesCollection) {
        throw new Error("Favorites collection does not exist");
    }

    const resolvedFiles = resolveFavoritesFilesForRemoval(
        ctx,
        favoritesCollection,
        files,
    );
    if (!resolvedFiles.length) {
        return [];
    }

    const uniqueResolved = uniqueFilesByID(resolvedFiles);
    await removeFromOwnCollection(
        toCollectionFilesContext(ctx),
        favoritesCollection.id,
        uniqueResolved,
    );

    rememberPendingFavoriteFiles(
        files,
        resolvedFiles,
        ctx.userId,
        ctx.pendingByHashAndType,
    );

    return uniqueResolved.map((file) => file.id);
};

export { findUserFavoritesCollection };
