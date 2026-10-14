import { encryptBox } from "ente-base/crypto/libsodium";
import { splitByPredicate } from "ente-utils/array";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { metadataHash } from "ente-media/file-metadata";
import { z } from "zod";
import { batched } from "@/lib/batched";
import { createRemoteCollection } from "./collections";
import type { HttpClient } from "./http";
import type { CoreSession } from "../session";

const copyRequestBatchSize = 100;
const uncategorizedCollectionName = "Uncategorized";

const CopyFilesResponse = z.object({
    oldToNewFileIDMap: z.record(z.string(), z.number()),
});

interface CollectionFileItem {
    id: number;
    encryptedKey: string;
    keyDecryptionNonce: string;
}

export interface CollectionFilesContext {
    http: HttpClient;
    session: CoreSession;
    userId: number;
    collections: Collection[];
    allFiles: EnteFile[];
}

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

const groupFilesByCollectionID = (
    files: EnteFile[],
): Map<number, EnteFile[]> => {
    const groups = new Map<number, EnteFile[]>();
    for (const file of files) {
        const group = groups.get(file.collectionID) ?? [];
        group.push(file);
        groups.set(file.collectionID, group);
    }
    return groups;
};

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

const fileIDsInCollection = (
    collectionID: number,
    collectionFiles: EnteFile[],
): Set<number> =>
    new Set(
        collectionFiles
            .filter((file) => file.collectionID === collectionID)
            .map((file) => file.id),
    );

const currentUserRoleInCollection = (
    collection: Collection,
    userId: number,
): string | undefined => {
    if (collection.owner.id === userId) {
        return "OWNER";
    }
    return collection.sharees.find((sharee) => sharee.id === userId)?.role;
};

const canAddFilesToCollection = (
    collection: Collection,
    userId: number,
): boolean => {
    const role = currentUserRoleInCollection(collection, userId);
    return role === "OWNER" || role === "ADMIN" || role === "COLLABORATOR";
};

const canDirectlyUploadToCollection = (
    collection: Collection,
    userId: number,
): boolean => collection.owner.id === userId;

const encryptWithCollectionKey = async (
    collection: Collection,
    files: EnteFile[],
): Promise<CollectionFileItem[]> =>
    Promise.all(
        files.map(async (file) => {
            const box = await encryptBox(file.key, collection.key);
            return {
                id: file.id,
                encryptedKey: box.encryptedData,
                keyDecryptionNonce: box.nonce,
            };
        }),
    );

const postJson = (
    ctx: CollectionFilesContext,
    path: string,
    body: unknown,
): Promise<Response> =>
    ctx.http.authFetch(path, undefined, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

/**
 * Link existing files to a collection on remote.
 */
export const addToCollection = async (
    ctx: CollectionFilesContext,
    collection: Collection,
    files: EnteFile[],
): Promise<void> => {
    await batched(files, async (batchFiles) => {
        const encryptedFileKeys = await encryptWithCollectionKey(
            collection,
            batchFiles,
        );
        await postJson(ctx, "/collections/add-files", {
            collectionID: collection.id,
            files: encryptedFileKeys,
        });
    });
};

/**
 * Copy non-owned files into an owned destination collection.
 */
const copyFiles = async (
    ctx: CollectionFilesContext,
    dstCollection: Collection,
    files: EnteFile[],
): Promise<EnteFile[]> => {
    if (!files.length) {
        return [];
    }

    const { userId } = ctx;
    if (dstCollection.owner.id !== userId) {
        throw new Error("Destination collection must be owned by the actor");
    }

    const uniqueFiles = uniqueFilesByID(files);
    const copiedFiles: EnteFile[] = [];

    for (const [srcCollectionID, sourceFiles] of groupFilesByCollectionID(
        uniqueFiles,
    ).entries()) {
        for (
            let i = 0;
            i < sourceFiles.length;
            i += copyRequestBatchSize
        ) {
            const batchFiles = sourceFiles.slice(i, i + copyRequestBatchSize);
            if (
                batchFiles.some(
                    (file) =>
                        file.ownerID === userId ||
                        file.collectionID !== srcCollectionID,
                )
            ) {
                throw new Error(
                    "Can only copy files owned by other users from the source collection",
                );
            }

            const encryptedFileKeys = await encryptWithCollectionKey(
                dstCollection,
                batchFiles,
            );
            const res = await postJson(ctx, "/files/copy", {
                dstCollectionID: dstCollection.id,
                srcCollectionID,
                files: encryptedFileKeys,
            });
            const { oldToNewFileIDMap } = CopyFilesResponse.parse(
                await res.json(),
            );

            for (const file of batchFiles) {
                const copiedFileID = oldToNewFileIDMap[file.id.toString()];
                if (!copiedFileID) {
                    throw new Error(`Failed to copy file ${file.id}`);
                }
                copiedFiles.push({
                    ...file,
                    id: copiedFileID,
                    ownerID: userId,
                    collectionID: dstCollection.id,
                });
            }
        }
    }

    return copiedFiles;
};

const moveFromCollection = async (
    ctx: CollectionFilesContext,
    fromCollectionID: number,
    toCollection: Collection,
    files: EnteFile[],
): Promise<void> => {
    await batched(files, async (batchFiles) => {
        const encryptedFileKeys = await encryptWithCollectionKey(
            toCollection,
            batchFiles,
        );
        await postJson(ctx, "/collections/move-files", {
            fromCollectionID,
            toCollectionID: toCollection.id,
            files: encryptedFileKeys,
        });
    });
};

const removeNonCollectionOwnerFiles = async (
    ctx: CollectionFilesContext,
    collectionID: number,
    files: EnteFile[],
): Promise<void> => {
    await batched(files, async (batchFiles) => {
        await postJson(ctx, "/collections/v3/remove-files", {
            collectionID,
            fileIDs: batchFiles.map((file) => file.id),
        });
    });
};

const findUserUncategorizedCollection = (
    ctx: CollectionFilesContext,
): Collection | undefined =>
    ctx.collections.find(
        (collection) =>
            collection.type === "uncategorized" &&
            collection.owner.id === ctx.userId,
    );

const savedOrCreateUserUncategorizedCollection = async (
    ctx: CollectionFilesContext,
): Promise<Collection> =>
    findUserUncategorizedCollection(ctx) ??
    createRemoteCollection(
        ctx.http,
        ctx.session,
        uncategorizedCollectionName,
        "uncategorized",
    );

const removeOwnFilesFromOwnCollection = async (
    ctx: CollectionFilesContext,
    collectionID: number,
    filesToRemove: EnteFile[],
): Promise<void> => {
    const { userId, collections, allFiles } = ctx;
    const collectionsByID = new Map(collections.map((c) => [c.id, c]));
    const filesToRemoveIDs = new Set(filesToRemove.map((file) => file.id));
    const pendingRemove = (file: EnteFile): boolean =>
        filesToRemoveIDs.has(file.id);

    const collectionFilesToRemove = allFiles.filter(pendingRemove);
    const groups = groupFilesByCollectionID(collectionFilesToRemove);

    for (const [targetCollectionID, filesInCollection] of groups.entries()) {
        if (targetCollectionID === collectionID) {
            continue;
        }

        const targetCollection = collectionsByID.get(targetCollectionID);
        if (
            targetCollection?.owner.id !== userId ||
            targetCollection.type === "uncategorized"
        ) {
            continue;
        }

        const filesInCollectionToRemove =
            filesInCollection.filter(pendingRemove);
        if (!filesInCollectionToRemove.length) {
            continue;
        }

        await moveFromCollection(
            ctx,
            collectionID,
            targetCollection,
            filesInCollectionToRemove,
        );
        filesInCollectionToRemove.forEach((file) => {
            filesToRemoveIDs.delete(file.id);
        });
    }

    const remainingFiles = filesToRemove.filter((file) =>
        filesToRemoveIDs.has(file.id));
    if (!remainingFiles.length) {
        return;
    }

    await moveFromCollection(
        ctx,
        collectionID,
        await savedOrCreateUserUncategorizedCollection(ctx),
        remainingFiles,
    );
};

export const removeFromOwnCollection = async (
    ctx: CollectionFilesContext,
    collectionID: number,
    files: EnteFile[],
): Promise<void> => {
    const { userId } = ctx;
    const [userFiles, nonUserFiles] = splitByPredicate(
        files,
        (file) => file.ownerID === userId,
    );
    if (userFiles.length) {
        await removeOwnFilesFromOwnCollection(ctx, collectionID, userFiles);
    }
    if (nonUserFiles.length) {
        await removeNonCollectionOwnerFiles(ctx, collectionID, nonUserFiles);
    }
};

/**
 * Add or copy files into a destination collection, reusing user-owned equivalents when possible.
 */
export const addOrCopyToCollection = async (
    ctx: CollectionFilesContext,
    dstCollection: Collection,
    files: EnteFile[],
): Promise<EnteFile[]> => {
    const addedFiles: EnteFile[] = [];
    if (!files.length) {
        return addedFiles;
    }

    if (!canAddFilesToCollection(dstCollection, ctx.userId)) {
        throw new Error("Current user cannot add files to this collection");
    }

    const { userId, allFiles } = ctx;
    const destinationFileIDs = fileIDsInCollection(dstCollection.id, allFiles);
    const filesMissingFromDestination = uniqueFilesByID(files).filter(
        (file) => !destinationFileIDs.has(file.id),
    );
    if (!filesMissingFromDestination.length) {
        return addedFiles;
    }

    const [ownedFiles, otherOwnedFiles] = splitByPredicate(
        filesMissingFromDestination,
        (file) => file.ownerID === userId,
    );

    if (ownedFiles.length) {
        await addToCollection(ctx, dstCollection, ownedFiles);
        ownedFiles.forEach((file) => destinationFileIDs.add(file.id));
        addedFiles.push(...ownedFiles);
    }

    if (!otherOwnedFiles.length) {
        return addedFiles;
    }

    const userOwnedFilesByHashAndType = userOwnedEquivalentFilesByHashAndType(
        allFiles,
        userId,
    );

    const filesToAdd = new Map<number, EnteFile>();
    const filesToCopy: EnteFile[] = [];

    for (const file of otherOwnedFiles) {
        const fileHashAndTypeKey = hashAndTypeKey(file);
        const userOwnedEquivalent = fileHashAndTypeKey ?
            userOwnedFilesByHashAndType.get(fileHashAndTypeKey) :
            undefined;

        if (userOwnedEquivalent) {
            filesToAdd.set(userOwnedEquivalent.id, userOwnedEquivalent);
        } else {
            filesToCopy.push(file);
        }
    }

    const reusableOwnedFiles = [...filesToAdd.values()].filter(
        (file) => !destinationFileIDs.has(file.id),
    );
    if (reusableOwnedFiles.length) {
        await addToCollection(ctx, dstCollection, reusableOwnedFiles);
        reusableOwnedFiles.forEach((file) => destinationFileIDs.add(file.id));
        addedFiles.push(...reusableOwnedFiles);
    }

    if (!filesToCopy.length) {
        return addedFiles;
    }

    const copyDestination = canDirectlyUploadToCollection(dstCollection, userId) ?
        dstCollection :
        await savedOrCreateUserUncategorizedCollection(ctx);

    const copiedFiles = await copyFiles(ctx, copyDestination, filesToCopy);

    if (copyDestination.id !== dstCollection.id) {
        const filesToAddAfterCopy = uniqueFilesByID(copiedFiles).filter(
            (file) => !destinationFileIDs.has(file.id),
        );
        if (filesToAddAfterCopy.length) {
            await addToCollection(ctx, dstCollection, filesToAddAfterCopy);
            filesToAddAfterCopy.forEach((file) =>
                destinationFileIDs.add(file.id));
            addedFiles.push(...filesToAddAfterCopy);
        }
    } else {
        addedFiles.push(...copiedFiles);
    }

    return addedFiles;
};
