/**
 * Sync organizer CLIP vectors via Ente `mldata` (`organizer_clip` key).
 *
 * Local IDB chunks remain the fast cache; remote is the cross-device source.
 */

import type { EnteFile } from "ente-media/file";
import { wait } from "ente-utils/promise";
import { getEnteCore } from "@/core";
import { syncUpdatedFileDataFileIDs } from "@/core/api/file-data";
import { getOrganizerDB } from "@/db";
import { appendEmbeddingChunk } from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";
import { l2NormalizeEmbedding } from "@/lib/embedding-vector";
import { waitWhileGalleryScrolling } from "@/lib/gallery-scroll-activity";
import {
    KIT_EMBEDDING_DIMS,
    embeddingToNumberArray,
    ensureEmbeddingMeta,
    type EmbeddingMap,
    type EmbeddingVector,
    type ReadonlyEmbeddingMap,
} from "@/lib/kit-embedding";
import { isEnteVideoFile } from "@/lib/media-kind";
import {
    ORGANIZER_CLIP_MLDATA_KEY,
    fetchOrganizerMLDataBatch,
    putOrganizerClip,
} from "@/lib/organizer-clip";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";

const mldataCursorMetaKey = "organizer-clip-mldata-cursor";
const uploadedIdsMetaKey = "organizer-clip-uploaded-ids";

const uploadConcurrency = 3;
const fetchBatchSize = 200;
/** Uploaded ids are persisted in groups this size (each save rewrites the set). */
const markUploadedBatchSize = 100;
/** First retry delay after a failed upload batch; doubles per failed batch. */
const uploadRetryBaseMs = 2_000;
/** Failed batches in a row before the drain stops until the next enqueue. */
const maxUploadFailureStreak = 5;

let uploadChain: Promise<void> = Promise.resolve();
const pendingUpload: EmbeddingMap = new Map();
let pullInFlight: Promise<EmbeddingMap> | undefined;
let uploadedIdsUpdate: Promise<void> = Promise.resolve();

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

/**
 * Load, change and save the uploaded set one update at a time, so the upload
 * drain and the pull never overwrite each other's marks.
 */
const updateUploadedIdSet = (
    change: (ids: Set<number>) => void,
): Promise<void> => {
    const update = uploadedIdsUpdate.then(async () => {
        const ids = await loadUploadedIdSet();
        const sizeBefore = ids.size;
        change(ids);
        if (ids.size !== sizeBefore) {
            await saveUploadedIdSet(ids);
        }
    });
    uploadedIdsUpdate = update.catch(() => undefined);
    return update;
};

const markUploaded = (fileIds: Iterable<number>): Promise<void> => {
    const added = [...fileIds];
    return updateUploadedIdSet((ids) => {
        for (const id of added) {
            ids.add(id);
        }
    });
};

const unmarkUploaded = (fileIds: Iterable<number>): Promise<void> => {
    const removed = [...fileIds];
    return updateUploadedIdSet((ids) => {
        for (const id of removed) {
            ids.delete(id);
        }
    });
};

/**
 * Queue newly computed vectors for mldata upload (non-blocking).
 */
export const enqueueOrganizerClipUpload = (
    entries: ReadonlyEmbeddingMap,
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

    const uploaded: number[] = [];
    let failureStreak = 0;
    try {
        while (pendingUpload.size > 0) {
            await waitWhileGalleryScrolling();
            const batch: Array<{ file: EnteFile; vector: EmbeddingVector }> =
                [];
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
            let failed = false;
            await Promise.all(
                batch.map(async ({ file, vector }) => {
                    try {
                        await putOrganizerClip(
                            http,
                            file,
                            embeddingToNumberArray(vector),
                        );
                        uploaded.push(file.id);
                    } catch (error) {
                        console.warn(
                            `[organizer-clip] upload failed for ${file.id}`,
                            error,
                        );
                        // Retry later.
                        pendingUpload.set(file.id, vector);
                        failed = true;
                    }
                }),
            );
            if (uploaded.length >= markUploadedBatchSize) {
                await markUploaded(uploaded.splice(0));
            }
            if (!failed) {
                failureStreak = 0;
                continue;
            }
            // Back off instead of hammering a failing endpoint (offline,
            // 429, 5xx); leave the rest queued for the next enqueue.
            failureStreak += 1;
            if (failureStreak >= maxUploadFailureStreak) {
                return;
            }
            await wait(uploadRetryBaseMs * 2 ** (failureStreak - 1));
        }
    } finally {
        if (uploaded.length > 0) {
            await markUploaded(uploaded);
        }
    }
};

/**
 * Pull remote `organizer_clip` updates into local embedding chunks.
 *
 * @param localEntries the hydrated in-memory index, when available; files
 * marked uploaded but missing from it are refetched (gap restore).
 * @returns newly applied vectors (for store merge)
 */
export const pullOrganizerClipSync = async (
    files: readonly EnteFile[],
    localEntries?: ReadonlyEmbeddingMap,
    signal?: AbortSignal,
): Promise<EmbeddingMap> => {
    if (pullInFlight) {
        return pullInFlight;
    }
    pullInFlight = (async (): Promise<EmbeddingMap> => {
        const applied = new Map();
        const core = getEnteCore();
        if (!core.isAuthenticated() || files.length === 0) {
            return applied;
        }
        const http = core.getHttpClient();
        const filesById = new Map(files.map((file) => [file.id, file]));
        let cursor = await loadMldataCursor();

        // Vectors marked uploaded but missing locally were lost from this
        // device's index after the cursor had already passed them.
        const gapIds = new Set<number>();
        if (localEntries) {
            for (const fileId of await loadUploadedIdSet()) {
                const file = filesById.get(fileId);
                if (file && !isEnteVideoFile(file) && !localEntries.has(fileId)) {
                    gapIds.add(fileId);
                }
            }
        }
        const pendingIds = new Set(gapIds);

        // The cursor is saved only once every listed vector is stored, so an
        // abort or failed fetch replays those pages instead of skipping them.
        await syncUpdatedFileDataFileIDs(
            http,
            "mldata",
            cursor,
            (page) => {
                if (signal?.aborted) {
                    return Promise.resolve();
                }
                cursor = page.lastUpdatedAt;
                for (const fileId of page.fileIDs) {
                    if (filesById.has(fileId)) {
                        pendingIds.add(fileId);
                    }
                }
                return Promise.resolve();
            },
        );

        if (signal?.aborted) {
            return applied;
        }
        if (pendingIds.size === 0) {
            await saveMldataCursor(cursor);
            return applied;
        }

        const cacheKey = getSessionCacheKey();
        await ensureEmbeddingMeta(cacheKey);

        const ids = [...pendingIds];
        for (let offset = 0; offset < ids.length; offset += fetchBatchSize) {
            if (signal?.aborted) {
                break;
            }
            await waitWhileGalleryScrolling(signal);
            const slice = ids.slice(offset, offset + fetchBatchSize);
            const sliceMap = new Map<number, EnteFile>();
            for (const id of slice) {
                const file = filesById.get(id);
                if (file) {
                    sliceMap.set(id, file);
                }
            }
            const mldata = await fetchOrganizerMLDataBatch(http, sliceMap);
            const chunk = new Map();
            const notOnRemote: number[] = [];
            for (const fileId of slice) {
                const data = mldata.get(fileId);
                const normalized =
                    data?.organizerClip &&
                    l2NormalizeEmbedding(data.organizerClip.embedding);
                if (normalized) {
                    chunk.set(fileId, normalized);
                    applied.set(fileId, normalized);
                } else if (
                    gapIds.has(fileId) ||
                    data?.raw[ORGANIZER_CLIP_MLDATA_KEY] === undefined
                ) {
                    notOnRemote.push(fileId);
                }
            }
            if (chunk.size > 0) {
                await appendEmbeddingChunk(chunk, cacheKey);
                await markUploaded(chunk.keys());
            }
            // The official app saves mldata without a version check and can
            // drop our key; unmarking lets the backfill re-upload the local
            // copy. A gap the remote can't fill is unmarked so it isn't
            // refetched every sync (the next CLIP scan re-embeds it).
            await unmarkUploaded(notOnRemote);
        }
        if (!signal?.aborted) {
            await saveMldataCursor(cursor);
        }
        return applied;
    })().finally(() => {
        pullInFlight = undefined;
    });
    return pullInFlight;
};

/**
 * One-shot: upload local vectors not yet marked uploaded (migration / backfill).
 * Resolves once the upload queue drains or backs off.
 */
export const backfillOrganizerClipUploads = async (
    files: readonly EnteFile[],
    localEntries: ReadonlyEmbeddingMap,
): Promise<number> => {
    const uploaded = await loadUploadedIdSet();
    const filesById = new Map(files.map((file) => [file.id, file]));
    const todo = new Map();
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
    await uploadChain.catch(() => undefined);
    return todo.size;
};

/**
 * Give a replacement upload (crop, auto-crop, compress) the vector of the file
 * it replaced, so the edit does not drop it from the index. Synced like a new
 * embedding.
 */
export const carryOverOrganizerClip = async (
    source: EnteFile,
    replacement: EnteFile,
): Promise<void> => {
    if (isEnteVideoFile(source)) {
        return;
    }
    await useEmbeddingIndexStore.getState().ensureHydrated();
    const vector = useEmbeddingIndexStore.getState().entries.get(source.id);
    if (!vector) {
        return;
    }
    const carried = new Map([[replacement.id, vector]]);
    await appendEmbeddingChunk(carried, getSessionCacheKey());
    const next = new Map(useEmbeddingIndexStore.getState().entries);
    next.set(replacement.id, vector);
    useEmbeddingIndexStore.getState().setEntries(next);
    enqueueOrganizerClipUpload(carried);
};

/**
 * Forget a file's vector after its pixels changed in place (rotate), so the
 * next CLIP scan re-embeds it and the upload replaces the stale remote copy.
 */
export const dropOrganizerClip = async (fileId: number): Promise<void> => {
    const cacheKey = getSessionCacheKey();
    await ensureEmbeddingMeta(cacheKey);
    await appendEmbeddingChunk(new Map([[fileId, null]]), cacheKey);
    await unmarkUploaded([fileId]);
    const { entries, isHydrated, setEntries } =
        useEmbeddingIndexStore.getState();
    if (isHydrated && entries.has(fileId)) {
        const next = new Map(entries);
        next.delete(fileId);
        setEntries(next);
    }
};
