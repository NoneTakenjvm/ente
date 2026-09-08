import {
    createMagicMetadata,
    encryptMagicMetadata,
} from "ente-media/magic-metadata";
import type { EnteFile } from "ente-media/file";
import type {
    FilePrivateMagicMetadataData,
    FilePublicMagicMetadataData,
    ItemVisibility,
} from "ente-media/file-metadata";
import { refetchFile } from "./api/files";
import type { HttpClient } from "./api/http";
import { extractTags } from "@/lib/tags";
import {
    buildOrganizerUpdate,
    type OrganizerPublicMetadata,
    type TagMutator,
} from "@/lib/tag-writes";

export class MetadataUpdateError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = "MetadataUpdateError";
    }
}

const parseRetryAfterMs = (header: string | null): number | undefined => {
    if (!header) {
        return undefined;
    }
    const seconds = Number(header);
    if (!Number.isFinite(seconds) || seconds < 0) {
        return undefined;
    }
    return seconds * 1000;
};

/**
 * Return decrypted public magic metadata for a file.
 */
export const getPublicMetadata = (
    file: EnteFile,
): FilePublicMagicMetadataData => file.pubMagicMetadata?.data ?? {};

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

type RemotePublicMagicMetadata = Awaited<
    ReturnType<typeof encryptMagicMetadata>
>;

/**
 * PUT one or more public-magic-metadata entries in a single request.
 *
 * Ente accepts up to 1000 items; the whole batch fails on any version conflict.
 */
export const putPublicMetadataList = async (
    http: HttpClient,
    metadataList: Array<{ id: number; magicMetadata: RemotePublicMagicMetadata }>,
): Promise<void> => {
    if (!metadataList.length) {
        return;
    }
    const res = await http.authFetchResponse(
        "/files/public-magic-metadata",
        undefined,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ metadataList }),
        },
    );

    if (!res.ok) {
        throw new MetadataUpdateError(
            `Failed to update metadata for ${metadataList.length} file(s)`,
            res.status,
            parseRetryAfterMs(res.headers.get("Retry-After")),
        );
    }
};

const pubMagicVersionForPut = (file: EnteFile): number | undefined => {
    const version = file.pubMagicMetadata?.version;
    // Ente versions start at 1. Optimistic overlays must not send 0.
    return version && version > 0 ? version : undefined;
};

const putPublicMetadata = async (
    http: HttpClient,
    file: EnteFile,
    data: FilePublicMagicMetadataData,
): Promise<void> => {
    const merged = createMagicMetadata(data, pubMagicVersionForPut(file));
    const magicMetadata = await encryptMagicMetadata(merged, file.key);
    await putPublicMetadataList(http, [{ id: file.id, magicMetadata }]);
    // Remote increments version after accepting the sent value.
    file.pubMagicMetadata = {
        version: magicMetadata.version + 1,
        count: magicMetadata.count,
        data: merged.data as FilePublicMagicMetadataData,
    };
};

const putPrivateMetadata = async (
    http: HttpClient,
    file: EnteFile,
    data: FilePrivateMagicMetadataData,
): Promise<void> => {
    const merged = createMagicMetadata(data, file.magicMetadata?.version);
    const magicMetadata = await encryptMagicMetadata(merged, file.key);

    const res = await http.authFetchResponse(
        "/files/magic-metadata",
        undefined,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                metadataList: [{ id: file.id, magicMetadata }],
            }),
        },
    );

    if (!res.ok) {
        throw new MetadataUpdateError(
            `Failed to update private metadata for file ${file.id}`,
            res.status,
            parseRetryAfterMs(res.headers.get("Retry-After")),
        );
    }

    file.magicMetadata = {
        version: magicMetadata.version + 1,
        count: magicMetadata.count,
        data: merged.data as FilePrivateMagicMetadataData,
    };
};

/**
 * Merge updates into public magic metadata and PUT to remote.
 */
export const updatePublicMetadata = async (
    http: HttpClient,
    file: EnteFile,
    updates: Partial<FilePublicMagicMetadataData>,
): Promise<void> => {
    const mergedData = {
        ...file.pubMagicMetadata?.data,
        ...withEditedAt(updates),
    } as FilePublicMagicMetadataData;
    await putPublicMetadata(http, file, mergedData);
};

const maxConflictAttempts = 4;

/**
 * Set file visibility (archive / visible) via private magic metadata.
 */
export const updateFileVisibility = async (
    http: HttpClient,
    file: EnteFile,
    collectionKey: string,
    visibility: ItemVisibility,
): Promise<EnteFile> => {
    for (let attempt = 0; attempt < maxConflictAttempts; attempt++) {
        try {
            const mergedData = {
                ...file.magicMetadata?.data,
                visibility,
            } as FilePrivateMagicMetadataData;
            await putPrivateMetadata(http, file, mergedData);
            return file;
        } catch (error) {
            if (
                !(error instanceof MetadataUpdateError) ||
                error.status !== 409 ||
                attempt === maxConflictAttempts - 1
            ) {
                throw error;
            }
            const fresh = await refetchFile(http, file, collectionKey);
            Object.assign(file, fresh);
        }
    }
    throw new Error(`Failed to update visibility for file ${file.id}`);
};

const applyOrganizerTagsLocally = (
    file: EnteFile,
    mutator: TagMutator,
): FilePublicMagicMetadataData => {
    const tags = mutator(extractTags(file));
    const update = buildOrganizerUpdate(tags);
    return {
        ...file.pubMagicMetadata?.data,
        ...update,
    } as OrganizerPublicMetadata;
};

/**
 * Encrypt organizer-tag updates for many files (no network).
 *
 * Works on shallow clones so in-flight encryption never mutates library state.
 */
export const prepareFilesTagMetadata = async (
    updates: Array<{ file: EnteFile; intendedTags: string[] }>,
): Promise<
    Array<{
        file: EnteFile;
        mergedData: FilePublicMagicMetadataData;
        magicMetadata: RemotePublicMagicMetadata;
    }>
> =>
    Promise.all(
        updates.map(async ({ file, intendedTags }) => {
            const working: EnteFile = { ...file };
            const mergedData = applyOrganizerTagsLocally(
                working,
                () => intendedTags,
            );
            const merged = createMagicMetadata(
                mergedData,
                pubMagicVersionForPut(working),
            );
            const magicMetadata = await encryptMagicMetadata(
                merged,
                working.key,
            );
            return {
                file: working,
                mergedData: merged.data as FilePublicMagicMetadataData,
                magicMetadata,
            };
        }),
    );

/**
 * Apply prepared tag metadata locally after a successful batch PUT.
 */
export const applyPreparedTagMetadata = (
    prepared: Array<{
        file: EnteFile;
        mergedData: FilePublicMagicMetadataData;
        magicMetadata: RemotePublicMagicMetadata;
    }>,
): EnteFile[] => {
    for (const entry of prepared) {
        entry.file.pubMagicMetadata = {
            version: entry.magicMetadata.version + 1,
            count: entry.magicMetadata.count,
            data: entry.mergedData,
        };
    }
    return prepared.map((entry) => entry.file);
};

/**
 * PUT organizer tags for many files in one request (no conflict retry).
 */
export const putFilesTags = async (
    http: HttpClient,
    updates: Array<{ file: EnteFile; intendedTags: string[] }>,
): Promise<EnteFile[]> => {
    const prepared = await prepareFilesTagMetadata(updates);
    await putPublicMetadataList(
        http,
        prepared.map((entry) => ({
            id: entry.file.id,
            magicMetadata: entry.magicMetadata,
        })),
    );
    return applyPreparedTagMetadata(prepared);
};

/**
 * Apply a tag mutator and PUT organizer tags, refetching on version conflict.
 *
 * Tag-only writes do not bump `editedAt` (avoids gallery resort noise).
 */
export const updateFileTags = async (
    http: HttpClient,
    file: EnteFile,
    collectionKey: string,
    mutator: TagMutator,
): Promise<EnteFile> => {
    for (let attempt = 0; attempt < maxConflictAttempts; attempt++) {
        try {
            const mergedData = applyOrganizerTagsLocally(file, mutator);
            await putPublicMetadata(http, file, mergedData);
            return file;
        } catch (error) {
            if (
                !(error instanceof MetadataUpdateError) ||
                error.status !== 409 ||
                attempt === maxConflictAttempts - 1
            ) {
                throw error;
            }
            const fresh = await refetchFile(http, file, collectionKey);
            Object.assign(file, fresh);
        }
    }
    throw new Error(`Failed to update tags for file ${file.id}`);
};
