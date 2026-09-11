import { z } from "zod";
import type { EncryptedBlobB64 } from "ente-base/crypto/types";
import type { HttpClient } from "./http";

/**
 * Museum "file data" types used by this app.
 *
 * @see [Note: File data APIs] in ente-gallery/services/file-data
 */
export type FileDataType = "mldata";

const RemoteFileDataSchema = z.object({
    fileID: z.number(),
    encryptedData: z.string(),
    decryptionHeader: z.string(),
    updatedAt: z.number().nullish(),
});

export type RemoteFileData = {
    fileID: number;
    encryptedData: string;
    decryptionHeader: string;
    updatedAt: number | undefined;
};

const RemoteFDStatusSchema = z.object({
    fileID: z.number(),
    type: z.string(),
    isDeleted: z.boolean(),
    updatedAt: z.number(),
});

export type UpdatedFileDataFileIDsPage = {
    fileIDs: Set<number>;
    lastUpdatedAt: number;
};

/**
 * Fetch encrypted file-data blobs of {@link type} for the given file ids.
 */
export const fetchFilesData = async (
    http: HttpClient,
    type: FileDataType,
    fileIDs: number[],
): Promise<RemoteFileData[]> => {
    if (fileIDs.length === 0) {
        return [];
    }
    const res = await http.authFetch("/files/data/fetch", undefined, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, fileIDs }),
    });
    const body = z
        .object({ data: z.array(RemoteFileDataSchema) })
        .parse(await res.json());
    return body.data.map((row) => ({
        fileID: row.fileID,
        encryptedData: row.encryptedData,
        decryptionHeader: row.decryptionHeader,
        updatedAt: row.updatedAt ?? undefined,
    }));
};

/**
 * Upload encrypted file-data for one file (optimistic locking via lastUpdatedAt).
 */
export const putFileData = async (
    http: HttpClient,
    fileID: number,
    type: FileDataType,
    encrypted: EncryptedBlobB64,
    lastUpdatedAt: number,
): Promise<void> => {
    const res = await http.authFetchResponse("/files/data", undefined, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            fileID,
            type,
            encryptedData: encrypted.encryptedData,
            decryptionHeader: encrypted.decryptionHeader,
            lastUpdatedAt,
        }),
    });
    if (res.status === 409) {
        throw new FileDataConflictError(fileID);
    }
    http.ensureOk(res);
};

/**
 * Walk `/files/data/status-diff` for creations/updates of {@link type}.
 */
export const syncUpdatedFileDataFileIDs = async (
    http: HttpClient,
    type: FileDataType,
    sinceUpdatedAt: number,
    onPage: (page: UpdatedFileDataFileIDsPage) => Promise<void>,
): Promise<void> => {
    let lastUpdatedAt = sinceUpdatedAt;
    while (true) {
        const res = await http.authFetch("/files/data/status-diff", undefined, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lastUpdatedAt }),
        });
        const parsed = z
            .object({
                diff: RemoteFDStatusSchema.array().nullish(),
            })
            .parse(await res.json());
        const diff = parsed.diff;
        if (!diff?.length) {
            break;
        }
        const fileIDs = new Set<number>();
        for (const fd of diff) {
            lastUpdatedAt = Math.max(lastUpdatedAt, fd.updatedAt);
            if (fd.type === type && !fd.isDeleted) {
                fileIDs.add(fd.fileID);
            }
        }
        await onPage({ fileIDs, lastUpdatedAt });
    }
};

/** Thrown when PUT mldata loses the optimistic-lock race. */
export class FileDataConflictError extends Error {
    readonly fileID: number;

    constructor(fileID: number) {
        super(`File data conflict for file ${fileID}`);
        this.name = "FileDataConflictError";
        this.fileID = fileID;
    }
}
