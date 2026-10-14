import {
    createMagicMetadata,
    decryptMagicMetadata,
    encryptMagicMetadata,
} from "ente-media/magic-metadata";
import type { EnteFile } from "ente-media/file";
import {
    fileCreationTime,
    type FilePrivateMagicMetadataData,
    type FilePublicMagicMetadataData,
    type ItemVisibility,
} from "ente-media/file-metadata";
import { isHTTPErrorWithStatus } from "ente-base/http";
import { getRemoteFile, refetchFile } from "./api/files";
import type { HttpClient } from "./api/http";

/**
 * Return decrypted public magic metadata for a file.
 */
export const getPublicMetadata = (
    file: EnteFile,
): FilePublicMagicMetadataData => file.pubMagicMetadata?.data ?? {};

/**
 * Sort key by the file's first upload time, newest first.
 *
 * Prefers the `uploadedAt` recorded in public magic metadata (stamped by this
 * app on upload and preserved across derived reuploads), falls back to
 * `updationTime` for legacy files uploaded elsewhere, then to the capture date.
 */
export const fileUploadSortTime = (file: EnteFile): number =>
    file.pubMagicMetadata?.data.uploadedAt ??
    file.updationTime ??
    fileCreationTime(file);

/**
 * Stamp a fresh edit timestamp into a public-metadata update.
 *
 * Used for user-visible edits that should affect "last edited" gallery sort
 * (visibility is private metadata; tag-only writes intentionally skip this).
 */
const withEditedAt = <T extends Record<string, unknown>>(
    updates: T,
): T & { editedAt: number } => ({
    ...updates,
    editedAt: Date.now() * 1000,
});

/**
 * Freeze the file's upload time into {@link data} if it has none yet.
 *
 * Files uploaded by other clients have no `uploadedAt`, so their upload sort
 * key falls back to `updationTime`, which every write bumps. Stamping it on the
 * first write stops that drift.
 */
const withUploadedAt = (
    file: EnteFile,
    data: FilePublicMagicMetadataData,
): FilePublicMagicMetadataData => ({
    ...data,
    uploadedAt: data.uploadedAt ?? fileUploadSortTime(file),
});

type RemoteMagicMetadata = Awaited<ReturnType<typeof encryptMagicMetadata>>;

/**
 * The version to send with a public-metadata PUT, or `undefined` for a file
 * with no remote public metadata yet.
 */
export const pubMagicVersionForPut = (file: EnteFile): number | undefined => {
    const version = file.pubMagicMetadata?.version;
    // Ente versions start at 1. Optimistic overlays must not send 0.
    return version && version > 0 ? version : undefined;
};

/**
 * PUT one or more magic-metadata entries in a single request.
 *
 * Ente accepts up to 1000 items; the whole batch fails on any version conflict
 * (an `HTTPError` with status 409).
 */
const putMetadata = async (
    http: HttpClient,
    path: "/files/public-magic-metadata" | "/files/magic-metadata",
    metadataList: Array<{ id: number; magicMetadata: RemoteMagicMetadata }>,
): Promise<void> => {
    await http.authFetch(path, undefined, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadataList }),
    });
};

/** Encrypt {@link mergedData} (stamping `uploadedAt`) as the next public magic metadata. */
const encryptPubMagic = async (
    file: EnteFile,
    mergedData: FilePublicMagicMetadataData,
): Promise<{
    magicMetadata: RemoteMagicMetadata;
    data: FilePublicMagicMetadataData;
}> => {
    const merged = createMagicMetadata(
        withUploadedAt(file, mergedData),
        pubMagicVersionForPut(file),
    );
    return {
        magicMetadata: await encryptMagicMetadata(merged, file.key),
        data: merged.data as FilePublicMagicMetadataData,
    };
};

/** Record on {@link file} the public metadata the server just accepted. */
const setSentPubMagic = (
    file: EnteFile,
    magicMetadata: RemoteMagicMetadata,
    data: FilePublicMagicMetadataData,
): void => {
    // Remote increments version after accepting the sent value.
    file.pubMagicMetadata = {
        version: magicMetadata.version + 1,
        count: magicMetadata.count,
        data,
    };
};

const putPublicMetadata = async (
    http: HttpClient,
    file: EnteFile,
    mergedData: FilePublicMagicMetadataData,
): Promise<void> => {
    const { magicMetadata, data } = await encryptPubMagic(file, mergedData);
    await putMetadata(http, "/files/public-magic-metadata", [
        { id: file.id, magicMetadata },
    ]);
    setSentPubMagic(file, magicMetadata, data);
};

const putPrivateMetadata = async (
    http: HttpClient,
    file: EnteFile,
    data: FilePrivateMagicMetadataData,
): Promise<void> => {
    const merged = createMagicMetadata(data, file.magicMetadata?.version);
    const magicMetadata = await encryptMagicMetadata(merged, file.key);
    await putMetadata(http, "/files/magic-metadata", [
        { id: file.id, magicMetadata },
    ]);
    file.magicMetadata = {
        version: magicMetadata.version + 1,
        count: magicMetadata.count,
        data: merged.data as FilePrivateMagicMetadataData,
    };
};

/** A partial public-metadata change, e.g. a built organizer block. */
type PublicMetadataUpdate = Record<string, unknown>;

const maxConflictAttempts = 4;

/**
 * Run {@link attempt}; on a 409 version conflict run {@link recover} and try
 * again, up to {@link maxConflictAttempts} times.
 */
const retryOnConflict = async (
    failureMessage: string,
    attempt: () => Promise<void>,
    recover: () => Promise<void>,
): Promise<void> => {
    for (let attemptIndex = 0; attemptIndex < maxConflictAttempts; attemptIndex++) {
        try {
            await attempt();
            return;
        } catch (error) {
            if (
                !isHTTPErrorWithStatus(error, 409) ||
                attemptIndex === maxConflictAttempts - 1
            ) {
                throw error;
            }
            await recover();
        }
    }
    throw new Error(failureMessage);
};

/**
 * Merge updates into public magic metadata and PUT to remote, re-reading the
 * remote public metadata and merging again on version conflict.
 */
export const updatePublicMetadata = (
    http: HttpClient,
    file: EnteFile,
    updates: Partial<FilePublicMagicMetadataData>,
): Promise<void> =>
    retryOnConflict(
        `Failed to update public metadata for file ${file.id}`,
        () =>
            putPublicMetadata(http, file, {
                ...file.pubMagicMetadata?.data,
                ...withEditedAt(updates),
            } as FilePublicMagicMetadataData),
        async () => {
            const { pubMagicMetadata } = await getRemoteFile(
                http,
                file.collectionID,
                file.id,
            );
            if (pubMagicMetadata) {
                file.pubMagicMetadata = (await decryptMagicMetadata(
                    pubMagicMetadata,
                    file.key,
                )) as EnteFile["pubMagicMetadata"];
            }
        },
    );

/**
 * Set file visibility (archive / visible) via private magic metadata.
 */
export const updateFileVisibility = async (
    http: HttpClient,
    file: EnteFile,
    collectionKey: string,
    visibility: ItemVisibility,
): Promise<EnteFile> => {
    await retryOnConflict(
        `Failed to update visibility for file ${file.id}`,
        () =>
            putPrivateMetadata(http, file, {
                ...file.magicMetadata?.data,
                visibility,
            } as FilePrivateMagicMetadataData),
        () => refetchAndAssign(http, file, collectionKey),
    );
    return file;
};

/**
 * Merge {@link updates} into public magic metadata for many files and PUT them
 * in one request (no conflict retry; a 409 fails the whole batch).
 *
 * Works on shallow clones so in-flight encryption never mutates library state;
 * returns the clones with the accepted metadata applied.
 */
export const putFilesPublicMetadata = async (
    http: HttpClient,
    updates: Array<{ file: EnteFile; updates: PublicMetadataUpdate }>,
): Promise<EnteFile[]> => {
    if (!updates.length) {
        return [];
    }
    const prepared = await Promise.all(
        updates.map(async (entry) => {
            const file: EnteFile = { ...entry.file };
            const { magicMetadata, data } = await encryptPubMagic(file, {
                ...file.pubMagicMetadata?.data,
                ...entry.updates,
            } as FilePublicMagicMetadataData);
            return { file, magicMetadata, data };
        }),
    );
    await putMetadata(
        http,
        "/files/public-magic-metadata",
        prepared.map(({ file, magicMetadata }) => ({
            id: file.id,
            magicMetadata,
        })),
    );
    return prepared.map(({ file, magicMetadata, data }) => {
        setSentPubMagic(file, magicMetadata, data);
        return file;
    });
};

/**
 * Merge {@link updates} into public magic metadata and PUT, refetching the file
 * on version conflict.
 *
 * Unlike {@link updatePublicMetadata} this does not bump `editedAt` (tag-only
 * writes avoid gallery resort noise).
 */
export const mergePublicMetadata = async (
    http: HttpClient,
    file: EnteFile,
    collectionKey: string,
    updates: PublicMetadataUpdate,
): Promise<EnteFile> => {
    await retryOnConflict(
        `Failed to update public metadata for file ${file.id}`,
        () =>
            putPublicMetadata(http, file, {
                ...file.pubMagicMetadata?.data,
                ...updates,
            } as FilePublicMagicMetadataData),
        () => refetchAndAssign(http, file, collectionKey),
    );
    return file;
};

const refetchAndAssign = async (
    http: HttpClient,
    file: EnteFile,
    collectionKey: string,
): Promise<void> => {
    Object.assign(file, await refetchFile(http, file, collectionKey));
};
