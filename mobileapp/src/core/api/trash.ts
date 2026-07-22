import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { RemoteEnteFile } from "ente-media/file";
import { z } from "zod";
import { batched } from "@/lib/batched";
import { encryptBox } from "ente-base/crypto/libsodium";
import type { HttpClient } from "./http";

/**
 * Move files to trash on remote (Ente trash, not permanent delete).
 */
export const moveToTrash = async (
    http: HttpClient,
    files: EnteFile[],
): Promise<void> => {
    if (!files.length) {
        return;
    }

    await batched(files, async (batchFiles) => {
        await http.authFetch("/files/trash", undefined, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                items: batchFiles.map((file) => ({
                    fileID: file.id,
                    collectionID: file.collectionID,
                })),
            }),
        });
    });
};

/**
 * Zod schema for a trash item as returned by the trash diff API.
 */
export const RemoteTrashItem = z.looseObject({
    file: RemoteEnteFile,
    isDeleted: z.boolean(),
    isRestored: z.boolean(),
    updatedAt: z.number(),
    deleteBy: z.number(),
});

export type RemoteTrashItem = z.infer<typeof RemoteTrashItem>;

const TrashDiffResponse = z.object({
    diff: RemoteTrashItem.array(),
    hasMore: z.boolean(),
});

/**
 * Fetch trash changes since {@link sinceTime} (epoch microseconds).
 */
export const getTrashDiff = async (
    http: HttpClient,
    sinceTime: number,
): Promise<{ diff: RemoteTrashItem[]; hasMore: boolean }> =>
    TrashDiffResponse.parse(
        await http.authFetchJSON("/trash/v2/diff", { sinceTime }),
    );

/**
 * Permanently delete the given file IDs from trash on remote.
 */
export const deleteFromTrash = async (
    http: HttpClient,
    fileIDs: number[],
): Promise<void> => {
    if (!fileIDs.length) {
        return;
    }
    await batched(fileIDs, async (batchIDs) => {
        await http.authFetch("/trash/delete", undefined, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileIDs: batchIDs }),
        });
    });
};

/**
 * Permanently delete trash entries with {@code updatedAt <= lastUpdatedAt}.
 */
export const emptyTrash = async (
    http: HttpClient,
    lastUpdatedAt: number,
): Promise<void> => {
    await http.authFetch("/trash/empty", undefined, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastUpdatedAt }),
    });
};

/**
 * Restore trashed files into {@link collection} (re-wraps file keys).
 */
export const restoreToCollection = async (
    http: HttpClient,
    collection: Collection,
    files: EnteFile[],
): Promise<void> => {
    if (!files.length) {
        return;
    }
    await batched(files, async (batchFiles) => {
        const encryptedFileKeys = await Promise.all(
            batchFiles.map(async (file) => {
                const box = await encryptBox(file.key, collection.key);
                return {
                    id: file.id,
                    encryptedKey: box.encryptedData,
                    keyDecryptionNonce: box.nonce,
                };
            }),
        );
        await http.authFetch("/collections/restore-files", undefined, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                collectionID: collection.id,
                files: encryptedFileKeys,
            }),
        });
    });
};
