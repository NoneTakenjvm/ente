import {
    FileDiffResponse,
    decryptRemoteFile,
    RemoteEnteFile,
    type EnteFile,
} from "ente-media/file";
import { z } from "zod";
import type { HttpClient } from "./http";

export interface CollectionFileChange {
    id: number;
    updationTime: number;
    isDeleted: boolean;
    remote?: RemoteEnteFile;
    file?: EnteFile;
}

export interface CollectionDiffResult {
    changes: CollectionFileChange[];
    hasMore: boolean;
}

/**
 * Fetch one page of file changes for a collection since {@link sinceTime}.
 */
export const getCollectionFileDiff = async (
    http: HttpClient,
    collectionID: number,
    sinceTime: number,
): Promise<CollectionDiffResult> => {
    const { diff, hasMore } = FileDiffResponse.parse(
        await http.authFetchJSON("/collections/v2/diff", {
            collectionID,
            sinceTime,
        }),
    );

    const changes: CollectionFileChange[] = diff.map((entry) => ({
        id: entry.id,
        updationTime: entry.updationTime,
        isDeleted: entry.isDeleted === true,
        remote: entry.isDeleted ? undefined : entry,
    }));

    return { changes, hasMore };
};

/**
 * Decrypt non-deleted diff entries.
 */
export const decryptFileChanges = async (
    changes: CollectionFileChange[],
    collectionKey: string,
): Promise<CollectionFileChange[]> =>
    Promise.all(
        changes.map(async (change) => {
            if (change.isDeleted || !change.remote) {
                return change;
            }
            return {
                ...change,
                file: await decryptRemoteFile(change.remote, collectionKey),
            };
        }),
    );

/**
 * Incrementally sync and decrypt files in a collection (full walk from cursor).
 */
export const syncCollectionFiles = async (
    http: HttpClient,
    collectionID: number,
    collectionKey: string,
    sinceTime = 0,
): Promise<EnteFile[]> => {
    const files: EnteFile[] = [];
    let cursor = sinceTime;

    while (true) {
        const { changes, hasMore } = await getCollectionFileDiff(
            http,
            collectionID,
            cursor,
        );

        if (!changes.length) {
            break;
        }

        const decrypted = await decryptFileChanges(changes, collectionKey);
        for (const change of decrypted) {
            cursor = Math.max(cursor, change.updationTime);
            if (!change.isDeleted && change.file) {
                files.push(change.file);
            }
        }

        if (!hasMore) {
            break;
        }
    }

    return files;
};

const GetFileResponse = z.object({ file: RemoteEnteFile });

/**
 * Fetch one encrypted file entry by collection + file id.
 */
export const getRemoteFile = async (
    http: HttpClient,
    collectionID: number,
    fileID: number,
): Promise<RemoteEnteFile> => {
    const { file } = GetFileResponse.parse(
        await http.authFetchJSON("/collections/file", {
            collectionID,
            fileID,
        }),
    );
    return file;
};

/**
 * Re-download and decrypt a single file (for metadata conflict recovery).
 */
export const refetchFile = async (
    http: HttpClient,
    file: EnteFile,
    collectionKey: string,
): Promise<EnteFile> => {
    const remote = await getRemoteFile(http, file.collectionID, file.id);
    return decryptRemoteFile(remote, collectionKey);
};
