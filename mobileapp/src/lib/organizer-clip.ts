/**
 * Organizer CLIP vectors in Ente `mldata` (namespaced away from official `clip`).
 *
 * [Note: Preserve unknown ML data fields] — always merge onto the raw JSON from
 * remote; never replace the whole object.
 */

import { encryptBlob, decryptBlobBytes } from "ente-base/crypto";
import type { EnteFile } from "ente-media/file";
import { z } from "zod";
import type { HttpClient } from "@/core/api/http";
import {
    fetchFilesData,
    putFileData,
    FileDataConflictError,
    type RemoteFileData,
} from "@/core/api/file-data";
import { gunzipToString, gzipString } from "@/lib/gzip";
import {
    KIT_EMBEDDING_DIMS,
    KIT_EMBEDDING_MODEL_ID,
} from "@/lib/kit-embedding";

export const ORGANIZER_CLIP_MLDATA_KEY = "organizer_clip" as const;

export const ORGANIZER_CLIP_CLIENT = "mobileapp-pwa";

export const ORGANIZER_CLIP_VERSION = 1;

const OrganizerClipSchema = z.object({
    version: z.number(),
    modelId: z.string(),
    client: z.string().optional(),
    embedding: z.array(z.number()),
});

export type OrganizerClipPayload = z.infer<typeof OrganizerClipSchema>;

export type RawRemoteMLData = Record<string, unknown>;

export type DecryptedMLData = {
    raw: RawRemoteMLData;
    updatedAt: number;
    organizerClip: OrganizerClipPayload | undefined;
};

/**
 * Build the `organizer_clip` object for upload.
 */
export const buildOrganizerClipPayload = (
    embedding: readonly number[],
): OrganizerClipPayload => ({
    version: ORGANIZER_CLIP_VERSION,
    modelId: KIT_EMBEDDING_MODEL_ID,
    client: ORGANIZER_CLIP_CLIENT,
    embedding: [...embedding],
});

/**
 * Parse a matching Xenova organizer vector from raw mldata, if present.
 */
export const parseOrganizerClip = (
    raw: RawRemoteMLData,
): OrganizerClipPayload | undefined => {
    const value = raw[ORGANIZER_CLIP_MLDATA_KEY];
    if (value === undefined || value === null) {
        return undefined;
    }
    const parsed = OrganizerClipSchema.safeParse(value);
    if (!parsed.success) {
        return undefined;
    }
    if (parsed.data.modelId !== KIT_EMBEDDING_MODEL_ID) {
        return undefined;
    }
    if (parsed.data.embedding.length !== KIT_EMBEDDING_DIMS) {
        return undefined;
    }
    return parsed.data;
};

/**
 * Merge our vector into existing mldata JSON (preserve face/clip/unknown).
 */
export const mergeOrganizerClipIntoRaw = (
    raw: RawRemoteMLData,
    embedding: readonly number[],
): RawRemoteMLData => ({
    ...raw,
    [ORGANIZER_CLIP_MLDATA_KEY]: buildOrganizerClipPayload(embedding),
});

const decryptRemoteMLData = async (
    remote: RemoteFileData,
    fileKey: string,
): Promise<DecryptedMLData> => {
    const bytes = await decryptBlobBytes(
        {
            encryptedData: remote.encryptedData,
            decryptionHeader: remote.decryptionHeader,
        },
        fileKey,
    );
    const jsonString = await gunzipToString(bytes);
    const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(jsonString));
    return {
        raw,
        updatedAt: remote.updatedAt ?? 0,
        organizerClip: parseOrganizerClip(raw),
    };
};

/**
 * Fetch and decrypt mldata for one file. Returns undefined when none exists.
 */
export const fetchOrganizerMLData = async (
    http: HttpClient,
    file: EnteFile,
): Promise<DecryptedMLData | undefined> => {
    const rows = await fetchFilesData(http, "mldata", [file.id]);
    const remote = rows.find((row) => row.fileID === file.id);
    if (!remote) {
        return undefined;
    }
    return decryptRemoteMLData(remote, file.key);
};

/**
 * Fetch mldata for many files; returns a map keyed by file id.
 */
export const fetchOrganizerMLDataBatch = async (
    http: HttpClient,
    filesById: Map<number, EnteFile>,
): Promise<Map<number, DecryptedMLData>> => {
    const ids = [...filesById.keys()];
    const result = new Map<number, DecryptedMLData>();
    const pageSize = 200;
    for (let offset = 0; offset < ids.length; offset += pageSize) {
        const slice = ids.slice(offset, offset + pageSize);
        const rows = await fetchFilesData(http, "mldata", slice);
        for (const remote of rows) {
            const file = filesById.get(remote.fileID);
            if (!file) {
                continue;
            }
            try {
                result.set(
                    remote.fileID,
                    await decryptRemoteMLData(remote, file.key),
                );
            } catch (error) {
                console.warn(
                    `[organizer-clip] skip unparseable mldata for ${remote.fileID}`,
                    error,
                );
            }
        }
    }
    return result;
};

/**
 * PUT organizer_clip merged onto existing mldata (409 → one refetch+retry).
 */
export const putOrganizerClip = async (
    http: HttpClient,
    file: EnteFile,
    embedding: readonly number[],
): Promise<void> => {
    const attempt = async (): Promise<void> => {
        const existing = await fetchOrganizerMLData(http, file);
        const raw = mergeOrganizerClipIntoRaw(existing?.raw ?? {}, embedding);
        const lastUpdatedAt = existing?.updatedAt ?? 0;
        const encrypted = await encryptBlob(
            await gzipString(JSON.stringify(raw)),
            file.key,
        );
        await putFileData(http, file.id, "mldata", encrypted, lastUpdatedAt);
    };

    try {
        await attempt();
    } catch (error) {
        if (!(error instanceof FileDataConflictError)) {
            throw error;
        }
        await attempt();
    }
};
