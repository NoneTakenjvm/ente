import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import type { PhashEntry } from "@/lib/crop-match";
import type {
    ViewSession,
    ViewSessionTombstone,
} from "@/lib/view-sessions";
import {
    decryptCachePayload,
    encryptCachePayload,
    type EncryptedPayload,
} from "./crypto";
import { getOrganizerDB, type KvKey } from "./index";

const getEncrypted = async (key: KvKey): Promise<EncryptedPayload | undefined> => {
    const db = await getOrganizerDB();
    const record = await db.get("kv", key);
    if (!record) {
        return undefined;
    }
    return {
        encryptedData: record.encryptedData,
        decryptionHeader: record.decryptionHeader,
    };
};

const putEncrypted = async (
    key: KvKey,
    payload: EncryptedPayload,
): Promise<void> => {
    const db = await getOrganizerDB();
    await db.put("kv", { key, ...payload });
};

export const loadEncryptedCollections = async (
    cacheKey: string,
): Promise<Collection[] | undefined> => {
    const payload = await getEncrypted("collections");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<Collection[]>(payload, cacheKey);
};

export const saveEncryptedCollections = async (
    collections: Collection[],
    cacheKey: string,
): Promise<void> => {
    await putEncrypted("collections", await encryptCachePayload(collections, cacheKey));
};

export const loadEncryptedFiles = async (
    cacheKey: string,
): Promise<EnteFile[] | undefined> => {
    const { loadEncryptedFilesSharded } = await import("./file-shards");
    return loadEncryptedFilesSharded(cacheKey);
};

export const saveEncryptedFiles = async (
    files: EnteFile[],
    cacheKey: string,
): Promise<void> => {
    const { saveEncryptedFilesSharded } = await import("./file-shards");
    await saveEncryptedFilesSharded(files, cacheKey);
};

export {
    markLibraryCacheFilesDirty,
    markLibraryCacheFullyDirty,
} from "./file-shards";

export interface PersistedTagIndex {
    tags: string[];
    fileIdsByTag: Record<string, number[]>;
}

export const loadEncryptedTagIndex = async (
    cacheKey: string,
): Promise<PersistedTagIndex | undefined> => {
    const payload = await getEncrypted("tagIndex");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<PersistedTagIndex>(payload, cacheKey);
};

export const saveEncryptedTagIndex = async (
    index: PersistedTagIndex,
    cacheKey: string,
): Promise<void> => {
    await putEncrypted("tagIndex", await encryptCachePayload(index, cacheKey));
};

/** Meta for chunked phash storage (v4); entries live in the `phashChunks` store. */
export interface PersistedPhashMeta {
    version: 4;
    nextChunkId: number;
}

/** fileId → entry, or null for a file removed since earlier chunks. */
interface PhashChunkPayload {
    entries: Record<number, PhashEntry | null>;
}

/**
 * Load the phash chunk meta. Older monolithic indexes (v3 and below) hold
 * point-sampled hashes that no longer compare against current ones, so they
 * read as absent and the caller rescans.
 */
export const loadPhashMeta = async (
    cacheKey: string,
): Promise<PersistedPhashMeta | undefined> => {
    const payload = await getEncrypted("phashIndex");
    if (!payload) {
        return undefined;
    }
    const meta = await decryptCachePayload<{ version?: number }>(
        payload,
        cacheKey,
    );
    return meta.version === 4 ? (meta as PersistedPhashMeta) : undefined;
};

/**
 * Append one encrypted chunk of phash entries; a `null` entry removes that
 * file. Callers must serialize appends so chunk ids never collide.
 *
 * [Note: Chunked phash persistence]
 *
 * Hashing a library writes many small chunks instead of re-encrypting the
 * whole index each time, and deletions are tombstones rather than rewrites.
 * Chunk ids only grow and IndexedDB returns rows in key order, so on load a
 * later chunk overrides an earlier one. {@link clearPhashChunks} compacts.
 */
export const appendPhashChunk = async (
    entries: ReadonlyMap<number, PhashEntry | null>,
    cacheKey: string,
): Promise<void> => {
    const meta = (await loadPhashMeta(cacheKey)) ?? {
        version: 4,
        nextChunkId: 0,
    };
    const chunkId = meta.nextChunkId;
    const payload: PhashChunkPayload = {
        entries: Object.fromEntries(entries),
    };
    const encrypted = await encryptCachePayload(payload, cacheKey);
    const db = await getOrganizerDB();
    await db.put("phashChunks", {
        chunkId,
        encryptedData: encrypted.encryptedData,
        decryptionHeader: encrypted.decryptionHeader,
    });
    const nextMeta: PersistedPhashMeta = {
        version: 4,
        nextChunkId: chunkId + 1,
    };
    await putEncrypted("phashIndex", await encryptCachePayload(nextMeta, cacheKey));
};

/** Read every phash chunk, applying later chunks (and removals) over earlier ones. */
export const loadAllPhashChunks = async (
    cacheKey: string,
): Promise<Map<number, PhashEntry>> => {
    const db = await getOrganizerDB();
    const records = await db.getAll("phashChunks");
    const entries = new Map<number, PhashEntry>();
    for (const record of records) {
        const payload = await decryptCachePayload<PhashChunkPayload>(
            {
                encryptedData: record.encryptedData,
                decryptionHeader: record.decryptionHeader,
            },
            cacheKey,
        );
        for (const [id, entry] of Object.entries(payload.entries)) {
            if (entry) {
                entries.set(Number(id), entry);
            } else {
                entries.delete(Number(id));
            }
        }
    }
    return entries;
};

/** Drop all phash chunks and reset the meta (before a compacting rewrite). */
export const clearPhashChunks = async (cacheKey: string): Promise<void> => {
    const db = await getOrganizerDB();
    await db.clear("phashChunks");
    const meta: PersistedPhashMeta = { version: 4, nextChunkId: 0 };
    await putEncrypted("phashIndex", await encryptCachePayload(meta, cacheKey));
};

/** fileId → combined quality score in [0, 1] (higher = better). */
export interface PersistedQualityIndex {
    version: 3;
    entries: Record<number, number>;
}

export const loadEncryptedQualityIndex = async (
    cacheKey: string,
): Promise<PersistedQualityIndex | undefined> => {
    const payload = await getEncrypted("qualityIndex");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<PersistedQualityIndex>(payload, cacheKey);
};

export const saveEncryptedQualityIndex = async (
    index: PersistedQualityIndex,
    cacheKey: string,
): Promise<void> => {
    await putEncrypted(
        "qualityIndex",
        await encryptCachePayload(index, cacheKey),
    );
};

export interface PersistedTagOutboxEntry {
    fileId: number;
    intendedTags: string[];
    enqueuedAt: number;
}

export const loadEncryptedTagOutbox = async (
    cacheKey: string,
): Promise<PersistedTagOutboxEntry[] | undefined> => {
    const payload = await getEncrypted("tagOutbox");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<PersistedTagOutboxEntry[]>(payload, cacheKey);
};

export const saveEncryptedTagOutbox = async (
    entries: PersistedTagOutboxEntry[],
    cacheKey: string,
): Promise<void> => {
    await putEncrypted(
        "tagOutbox",
        await encryptCachePayload(entries, cacheKey),
    );
};

export interface PersistedFavoriteOutboxEntry {
    fileId: number;
    isFavorite: boolean;
    fileHashAndTypeKey?: string;
    enqueuedAt: number;
}

export const loadEncryptedFavoriteOutbox = async (
    cacheKey: string,
): Promise<PersistedFavoriteOutboxEntry[] | undefined> => {
    const payload = await getEncrypted("favoriteOutbox");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<PersistedFavoriteOutboxEntry[]>(
        payload,
        cacheKey,
    );
};

export const saveEncryptedFavoriteOutbox = async (
    entries: PersistedFavoriteOutboxEntry[],
    cacheKey: string,
): Promise<void> => {
    await putEncrypted(
        "favoriteOutbox",
        await encryptCachePayload(entries, cacheKey),
    );
};

/**
 * File IDs present in the user's Favourites collection on remote
 * (membership oracle — independent of deduped library `collectionID`).
 */
export const loadEncryptedFavoriteMembership = async (
    cacheKey: string,
): Promise<number[] | undefined> => {
    const payload = await getEncrypted("favoriteMembership");
    if (!payload) {
        return undefined;
    }
    const decoded = await decryptCachePayload<unknown>(payload, cacheKey);
    if (!Array.isArray(decoded)) {
        return undefined;
    }
    const ids = decoded.filter(
        (id): id is number => typeof id === "number" && Number.isFinite(id),
    );
    return ids.length === decoded.length ? ids : undefined;
};

export const saveEncryptedFavoriteMembership = async (
    fileIds: number[],
    cacheKey: string,
): Promise<void> => {
    await putEncrypted(
        "favoriteMembership",
        await encryptCachePayload(fileIds, cacheKey),
    );
};

export interface PersistedVisibilityOutboxEntry {
    fileId: number;
    visibility: number;
    enqueuedAt: number;
}

export const loadEncryptedVisibilityOutbox = async (
    cacheKey: string,
): Promise<PersistedVisibilityOutboxEntry[] | undefined> => {
    const payload = await getEncrypted("visibilityOutbox");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<PersistedVisibilityOutboxEntry[]>(
        payload,
        cacheKey,
    );
};

export const saveEncryptedVisibilityOutbox = async (
    entries: PersistedVisibilityOutboxEntry[],
    cacheKey: string,
): Promise<void> => {
    await putEncrypted(
        "visibilityOutbox",
        await encryptCachePayload(entries, cacheKey),
    );
};

export interface PersistedDerivedReplaceOutboxEntry {
    fileId: number;
    width: number;
    height: number;
    kind: "crop" | "rotate" | "auto-crop" | "video-edit" | "compress";
    enqueuedAt: number;
    /** @deprecated Legacy field; ignored on hydrate. */
    bytesBase64?: string;
}

export const loadEncryptedDerivedReplaceOutbox = async (
    cacheKey: string,
): Promise<PersistedDerivedReplaceOutboxEntry[] | undefined> => {
    const payload = await getEncrypted("derivedReplaceOutbox");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<PersistedDerivedReplaceOutboxEntry[]>(
        payload,
        cacheKey,
    );
};

export const saveEncryptedDerivedReplaceOutbox = async (
    entries: PersistedDerivedReplaceOutboxEntry[],
    cacheKey: string,
): Promise<void> => {
    await putEncrypted(
        "derivedReplaceOutbox",
        await encryptCachePayload(entries, cacheKey),
    );
};

/** Decrypted trash item persisted for offline / Manage → Trash. */
export interface PersistedTrashItem {
    file: EnteFile;
    updatedAt: number;
    deleteBy: number;
}

export interface PersistedTrashCollectionKey {
    id: number;
    key: string;
}

export const loadEncryptedTrashItems = async (
    cacheKey: string,
): Promise<PersistedTrashItem[] | undefined> => {
    const payload = await getEncrypted("trashItems");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<PersistedTrashItem[]>(payload, cacheKey);
};

export const saveEncryptedTrashItems = async (
    items: PersistedTrashItem[],
    cacheKey: string,
): Promise<void> => {
    await putEncrypted("trashItems", await encryptCachePayload(items, cacheKey));
};

export const loadEncryptedTrashCollectionKeys = async (
    cacheKey: string,
): Promise<PersistedTrashCollectionKey[] | undefined> => {
    const payload = await getEncrypted("trashCollectionKeys");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<PersistedTrashCollectionKey[]>(payload, cacheKey);
};

export const saveEncryptedTrashCollectionKeys = async (
    keys: PersistedTrashCollectionKey[],
    cacheKey: string,
): Promise<void> => {
    await putEncrypted(
        "trashCollectionKeys",
        await encryptCachePayload(keys, cacheKey),
    );
};

/** CLIP vectors for kit nearness ranking (and corpus export). */
export interface PersistedEmbeddingIndex {
    version: 1;
    modelId: string;
    dims: number;
    /** fileId → L2-normalized float embedding */
    entries: Record<number, number[]>;
}

/**
 * Meta for chunked embedding storage (v2). Vectors live in the
 * {@code embeddingChunks} object store — each flush encrypts only the dirty
 * batch, not the whole library. Chunk rows are discovered via getAll (no
 * growing chunkIds list to re-encrypt every flush).
 */
export interface PersistedEmbeddingMeta {
    version: 2;
    modelId: string;
    dims: number;
    nextChunkId: number;
}

export interface EmbeddingChunkPayload {
    entries: Record<number, number[]>;
}

export const loadEncryptedEmbeddingIndex = async (
    cacheKey: string,
): Promise<PersistedEmbeddingIndex | undefined> => {
    const payload = await getEncrypted("embeddingIndex");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<PersistedEmbeddingIndex>(payload, cacheKey);
};

export const saveEncryptedEmbeddingIndex = async (
    index: PersistedEmbeddingIndex,
    cacheKey: string,
): Promise<void> => {
    await putEncrypted(
        "embeddingIndex",
        await encryptCachePayload(index, cacheKey),
    );
};

export const loadEmbeddingMeta = async (
    cacheKey: string,
): Promise<PersistedEmbeddingMeta | undefined> => {
    const payload = await getEncrypted("embeddingIndex");
    if (!payload) {
        return undefined;
    }
    const parsed = await decryptCachePayload<
        PersistedEmbeddingMeta | PersistedEmbeddingIndex
    >(payload, cacheKey);
    if (!parsed || typeof parsed !== "object") {
        return undefined;
    }
    if ((parsed as PersistedEmbeddingMeta).version === 2) {
        return parsed as PersistedEmbeddingMeta;
    }
    // v1 monolith is obsolete — caller treats as empty and rescans.
    return undefined;
};

export const saveEmbeddingMeta = async (
    meta: PersistedEmbeddingMeta,
    cacheKey: string,
): Promise<void> => {
    await putEncrypted(
        "embeddingIndex",
        await encryptCachePayload(meta, cacheKey),
    );
};

export const clearEmbeddingChunks = async (): Promise<void> => {
    const db = await getOrganizerDB();
    await db.clear("embeddingChunks");
};

/**
 * Encrypt and append one embedding chunk; updates meta atomically after write.
 * Accepts packed or plain vectors — disk payload is always number[].
 */
export const appendEmbeddingChunk = async (
    entries: ReadonlyMap<number, ArrayLike<number>>,
    meta: PersistedEmbeddingMeta,
    cacheKey: string,
): Promise<PersistedEmbeddingMeta> => {
    if (entries.size === 0) {
        return meta;
    }
    const chunkId = meta.nextChunkId;
    const jsonEntries: Record<number, number[]> = {};
    for (const [fileId, vector] of entries) {
        jsonEntries[fileId] = Array.isArray(vector) ?
            vector :
            Array.from(vector);
    }
    const payload: EmbeddingChunkPayload = {
        entries: jsonEntries,
    };
    const encrypted = await encryptCachePayload(payload, cacheKey);
    const db = await getOrganizerDB();
    await db.put("embeddingChunks", {
        chunkId,
        modelId: meta.modelId,
        dims: meta.dims,
        encryptedData: encrypted.encryptedData,
        decryptionHeader: encrypted.decryptionHeader,
    });
    const nextMeta: PersistedEmbeddingMeta = {
        ...meta,
        nextChunkId: chunkId + 1,
    };
    await saveEmbeddingMeta(nextMeta, cacheKey);
    return nextMeta;
};

/**
 * Decrypt all chunks for the given model and merge into a packed map.
 */
export const loadAllEmbeddingChunks = async (
    meta: PersistedEmbeddingMeta,
    cacheKey: string,
): Promise<Map<number, Float32Array>> => {
    const db = await getOrganizerDB();
    const map = new Map<number, Float32Array>();
    const records = await db.getAll("embeddingChunks");
    for (const record of records) {
        if (record.modelId !== meta.modelId || record.dims !== meta.dims) {
            continue;
        }
        const payload = await decryptCachePayload<EmbeddingChunkPayload>(
            {
                encryptedData: record.encryptedData,
                decryptionHeader: record.decryptionHeader,
            },
            cacheKey,
        );
        for (const [id, vector] of Object.entries(payload.entries)) {
            if (Array.isArray(vector) && vector.length === meta.dims) {
                map.set(Number(id), Float32Array.from(vector));
            }
        }
    }
    return map;
};

export interface PersistedViewSessions {
    sessions: ViewSession[];
    /** Deleted session ids retained for cloud LWW merge. */
    tombstones?: ViewSessionTombstone[];
}

export const loadEncryptedViewSessions = async (
    cacheKey: string,
): Promise<PersistedViewSessions | undefined> => {
    const payload = await getEncrypted("viewSessions");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<PersistedViewSessions>(payload, cacheKey);
};

export const saveEncryptedViewSessions = async (
    data: PersistedViewSessions,
    cacheKey: string,
): Promise<void> => {
    await putEncrypted(
        "viewSessions",
        await encryptCachePayload(data, cacheKey),
    );
};
