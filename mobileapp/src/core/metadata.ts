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

const putPublicMetadata = async (
    http: HttpClient,
    file: EnteFile,
    data: FilePublicMagicMetadataData,
): Promise<void> => {
    const merged = createMagicMetadata(data, file.pubMagicMetadata?.version);
    const magicMetadata = await encryptMagicMetadata(merged, file.key);

    const res = await http.authFetchResponse(
        "/files/public-magic-metadata",
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
            `Failed to update metadata for file ${file.id}`,
            res.status,
            parseRetryAfterMs(res.headers.get("Retry-After")),
        );
    }

    file.pubMagicMetadata = {
        version: magicMetadata.version,
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
        version: magicMetadata.version,
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
        ...updates,
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

const applyOrganizerTags = async (
    http: HttpClient,
    file: EnteFile,
    mutator: TagMutator,
): Promise<void> => {
    const tags = mutator(extractTags(file));
    const update = buildOrganizerUpdate(tags);
    const mergedData = {
        ...file.pubMagicMetadata?.data,
        ...update,
    } as OrganizerPublicMetadata;
    await putPublicMetadata(http, file, mergedData);
};

/**
 * Apply a tag mutator and PUT organizer tags, refetching on version conflict.
 */
export const updateFileTags = async (
    http: HttpClient,
    file: EnteFile,
    collectionKey: string,
    mutator: TagMutator,
): Promise<EnteFile> => {
    for (let attempt = 0; attempt < maxConflictAttempts; attempt++) {
        try {
            await applyOrganizerTags(http, file, mutator);
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
