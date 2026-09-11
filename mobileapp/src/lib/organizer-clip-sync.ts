/**
 * Sync organizer CLIP vectors via Ente `mldata` (`organizer_clip` key).
 *
 * Local IDB chunks remain the fast cache; remote is the cross-device source.
 */

import type { EnteFile } from "ente-media/file";
import { getEnteCore } from "@/core";
import { syncUpdatedFileDataFileIDs } from "@/core/api/file-data";
import { getOrganizerDB } from "@/db";
import {
    appendEmbeddingChunk,
    loadEmbeddingMeta,
    saveEmbeddingMeta,
    type PersistedEmbeddingMeta,
} from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";
import { waitWhileGalleryScrolling } from "@/lib/gallery-scroll-activity";
import {
    KIT_EMBEDDING_DIMS,
    KIT_EMBEDDING_MODEL_ID,
    l2NormalizeEmbedding,
} from "@/lib/kit-embedding";
import {
    fetchOrganizerMLDataBatch,
    putOrganizerClip,
} from "@/lib/organizer-clip";

const mldataCursorMetaKey = "organizer-clip-mldata-cursor";
const uploadedIdsMetaKey = "organizer-clip-uploaded-ids";

const uploadConcurrency = 3;
const fetchBatchSize = 200;

let uploadChain: Promise<void> = Promise.resolve();
const pendingUpload = new Map<number, number[]>();
let pullInFlight: Promise<Map<number, number[]>> | undefined;

const emptyMeta = (): PersistedEmbeddingMeta => ({
    version: 2,
    modelId: KIT_EMBEDDING_MODEL_ID,
    dims: KIT_EMBEDDING_DIMS,
    nextChunkId: 0,
});

const loadMldataCursor = async (): Promise<number> => {
    const db = await getOrganizerDB();
    const value = await db.get("meta", mldataCursorMetaKey);
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const saveMldataCursor = async (cursor: number): Promise<void> => {
    const db = await getOrganizerDB();
    await db.put("meta", cursor, mldataCursorMetaKey);
};

const loadUploadedIdSet = async (): Promise<Set<number>> => {
    const db = await getOrganizerDB();
    const value = await db.get("meta", uploadedIdsMetaKey);
    if (typeof value !== "string" || value.length === 0) {
        return new Set();
    }
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed)) {
            return new Set();
        }
        return new Set(
            parsed.filter((id): id is number => typeof id === "number"),
        );
    } catch {
        return new Set();
    }
};

const saveUploadedIdSet = async (ids: Set<number>): Promise<void> => {
    const db = await getOrganizerDB();
    await db.put("meta", JSON.stringify([...ids]), uploadedIdsMetaKey);
};

const markUploaded = async (fileIds: Iterable<number>): Promise<void> => {
    const set = await loadUploadedIdSet();
    let changed = false;
    for (const id of fileIds) {
        if (!set.has(id)) {
            set.add(id);
            changed = true;
        }
    }
    if (changed) {
        await saveUploadedIdSet(set);
    }
};

/**
 * Queue newly computed vectors for mldata upload (non-blocking).
 */
export const enqueueOrganizerClipUpload = (
    entries: ReadonlyMap<number, number[]>,
): void => {
    if (entries.size === 0) {
        return;
    }
    for (const [fileId, vector] of entries) {
        pendingUpload.set(fileId, vector);
    }
    uploadChain = uploadChain
        .catch(() => undefined)
        .then(() => drainOrganizerClipUploads());
};

const drainOrganizerClipUploads = async (): Promise<void> => {
    const core = getEnteCore();
    if (!core.isAuthenticated()) {
        return;
    }
    const http = core.getHttpClient();
    const filesById = new Map(
        (await import("@/stores/library-store")).useLibraryStore
            .getState()
            .allFiles.map((file) => [file.id, file] as const),
    );

    while (pendingUpload.size > 0) {
        await waitWhileGalleryScrolling();
        const batch: Array<{ file: EnteFile; vector: number[] }> = [];
        for (const [fileId, vector] of pendingUpload) {
            const file = filesById.get(fileId);
            pendingUpload.delete(fileId);
            if (!file?.key || vector.length !== KIT_EMBEDDING_DIMS) {
                continue;
            }
            batch.push({ file, vector });
            if (batch.length >= uploadConcurrency) {
                break;
            }
        }
        if (batch.length === 0) {
            continue;
        }
        const uploaded: number[] = [];
        await Promise.all(
            batch.map(async ({ file, vector }) => {
                try {
                    await putOrganizerClip(http, file, vector);
                    uploaded.push(file.id);
                } catch (error) {
                    console.warn(
                        `[organizer-clip] upload failed for ${file.id}`,
                        error,
                    );
                    // Retry later.
                    pendingUpload.set(file.id, vector);
                }
            }),
        );
        if (uploaded.length > 0) {
            await markUploaded(uploaded);
        }
    }
};

/**
 * Pull remote `organizer_clip` updates into local embedding chunks.
 *
 * @returns newly applied vectors (for store merge)
 */
export const pullOrganizerClipSync = async (
    files: readonly EnteFile[],
    signal?: AbortSignal,
): Promise<Map<number, number[]>> => {
    if (pullInFlight) {
        return pullInFlight;
    }
    pullInFlight = (async (): Promise<Map<number, number[]>> => {
        const applied = new Map<number, number[]>();
        const core = getEnteCore();
        if (!core.isAuthenticated() || files.length === 0) {
            return applied;
        }
        const http = core.getHttpClient();
        const filesById = new Map(files.map((file) => [file.id, file]));
        let cursor = await loadMldataCursor();
        const pendingIds: number[] = [];

        await syncUpdatedFileDataFileIDs(http, "mldata", cursor, async (page) => {
            if (signal?.aborted) {
                return;
            }
            cursor = page.lastUpdatedAt;
            for (const fileId of page.fileIDs) {
                if (filesById.has(fileId)) {
                    pendingIds.push(fileId);
                }
            }
            await saveMldataCursor(cursor);
        });

        if (signal?.aborted || pendingIds.length === 0) {
            return applied;
        }

        const cacheKey = getSessionCacheKey();
        let meta =
            (await loadEmbeddingMeta(cacheKey)) ?? emptyMeta();
        if (meta.modelId !== KIT_EMBEDDING_MODEL_ID) {
            meta = emptyMeta();
            await saveEmbeddingMeta(meta, cacheKey);
        }

        for (let offset = 0; offset < pendingIds.length; offset += fetchBatchSize) {
            if (signal?.aborted) {
                break;
            }
            await waitWhileGalleryScrolling(signal);
            const slice = pendingIds.slice(offset, offset + fetchBatchSize);
            const sliceMap = new Map<number, EnteFile>();
            for (const id of slice) {
                const file = filesById.get(id);
                if (file) {
                    sliceMap.set(id, file);
                }
            }
            const mldata = await fetchOrganizerMLDataBatch(http, sliceMap);
            const chunk = new Map<number, number[]>();
            for (const [fileId, data] of mldata) {
                const clip = data.organizerClip;
                if (!clip) {
                    continue;
                }
                const normalized = l2NormalizeEmbedding(clip.embedding);
                if (!normalized) {
                    continue;
                }
                chunk.set(fileId, normalized);
                applied.set(fileId, normalized);
            }
            if (chunk.size > 0) {
                meta = await appendEmbeddingChunk(chunk, meta, cacheKey);
                await markUploaded(chunk.keys());
            }
        }
        return applied;
    })().finally(() => {
        pullInFlight = undefined;
    });
    return pullInFlight;
};

/**
 * One-shot: upload local vectors not yet marked uploaded (migration / backfill).
 */
export const backfillOrganizerClipUploads = async (
    files: readonly EnteFile[],
    localEntries: ReadonlyMap<number, number[]>,
    signal?: AbortSignal,
): Promise<number> => {
    const uploaded = await loadUploadedIdSet();
    const filesById = new Map(files.map((file) => [file.id, file]));
    const todo = new Map<number, number[]>();
    for (const [fileId, vector] of localEntries) {
        if (uploaded.has(fileId)) {
            continue;
        }
        if (!filesById.has(fileId)) {
            continue;
        }
        todo.set(fileId, vector);
    }
    if (todo.size === 0) {
        return 0;
    }
    enqueueOrganizerClipUpload(todo);
    // Wait for drain unless aborted.
    while (pendingUpload.size > 0 && !signal?.aborted) {
        await uploadChain.catch(() => undefined);
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
        });
    }
    return todo.size;
};
