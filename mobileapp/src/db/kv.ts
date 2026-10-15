import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import type { PhashEntry } from "@/lib/crop-match";
import { getSessionCacheKey } from "@/lib/cache-key";
import type {
    ViewSession,
    ViewSessionTombstone,
} from "@/lib/view-sessions";
import { decryptCachePayload, encryptCachePayload } from "./crypto";
import { getOrganizerDB, type KvKey } from "./index";

export interface PersistedTagIndex {
    tags: string[];
    fileIdsByTag: Record<string, number[]>;
}

/** Meta for chunked phash storage (v4); entries live in the `phashChunks` store. */
interface PersistedPhashMeta {
    version: 4;
    nextChunkId: number;
}

/** fileId → entry, or null for a file removed since earlier chunks. */
interface PhashChunkPayload {
    entries: Record<number, PhashEntry | null>;
}

/** fileId → combined quality score in [0, 1] (higher = better). */
interface PersistedQualityIndex {
    version: 3;
    entries: Record<number, number>;
}

interface PersistedTagOutboxEntry {
    fileId: number;
    intendedTags: string[];
    enqueuedAt: number;
}

interface PersistedFavoriteOutboxEntry {
    fileId: number;
    isFavorite: boolean;
    fileHashAndTypeKey?: string;
    enqueuedAt: number;
}

interface PersistedVisibilityOutboxEntry {
    fileId: number;
    visibility: number;
    enqueuedAt: number;
}

export interface PersistedDerivedReplaceOutboxEntry {
    fileId: number;
    width: number;
    height: number;
    kind: "crop" | "rotate" | "auto-crop" | "video-edit" | "compress";
    enqueuedAt: number;
    /** @deprecated Legacy field; ignored on hydrate. */
    bytesBase64?: string;
}

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

/** fileId → vector, or null for a file removed since earlier chunks. */
interface EmbeddingChunkPayload {
    entries: Record<number, number[] | null>;
}

interface PersistedViewSessions {
    sessions: ViewSession[];
    /** Deleted session ids retained for cloud LWW merge. */
    tombstones?: ViewSessionTombstone[];
}

/** Decrypted value type of every `kv` record, by key. */
interface KvValues {
    collections: Collection[];
    tagIndex: PersistedTagIndex;
    /** Older versions are still present on disk; callers check `version`. */
    phashIndex: { version?: number; nextChunkId?: number };
    qualityIndex: PersistedQualityIndex;
    embeddingIndex: PersistedEmbeddingMeta;
    tagOutbox: PersistedTagOutboxEntry[];
    favoriteOutbox: PersistedFavoriteOutboxEntry[];
    /**
     * File IDs present in the user's Favourites collection on remote
     * (membership oracle — independent of deduped library `collectionID`).
     */
    favoriteMembership: number[];
    visibilityOutbox: PersistedVisibilityOutboxEntry[];
    derivedReplaceOutbox: PersistedDerivedReplaceOutboxEntry[];
    trashItems: PersistedTrashItem[];
    trashCollectionKeys: PersistedTrashCollectionKey[];
    viewSessions: PersistedViewSessions;
}

type ChunkStore = "phashChunks" | "embeddingChunks";

/**
 * Load and decrypt a `kv` record; `undefined` when nothing is stored.
 *
 * @param cacheKey defaults to the session cache key.
 */
export const loadKv = async <K extends keyof KvValues & KvKey>(
    key: K,
    cacheKey: string = getSessionCacheKey(),
): Promise<KvValues[K] | undefined> => {
    const db = await getOrganizerDB();
    const record = await db.get("kv", key);
    if (!record) {
        return undefined;
    }
    return decryptCachePayload<KvValues[K]>(
        {
            encryptedData: record.encryptedData,
            decryptionHeader: record.decryptionHeader,
        },
        cacheKey,
    );
};

/** Encrypt and store a `kv` record. */
export const saveKv = async <K extends keyof KvValues & KvKey>(
    key: K,
    value: KvValues[K],
    cacheKey: string = getSessionCacheKey(),
): Promise<void> => {
    const payload = await encryptCachePayload(value, cacheKey);
    const db = await getOrganizerDB();
    await db.put("kv", { key, ...payload });
};

/**
 * Encrypt `payload` and append it to a chunk store as row `record.chunkId`
 * (plus any extra plaintext fields on `record`). The caller updates its meta.
 */
const appendChunk = async (
    store: ChunkStore,
    record: { chunkId: number; modelId?: string; dims?: number },
    payload: unknown,
    cacheKey: string,
): Promise<void> => {
    const encrypted = await encryptCachePayload(payload, cacheKey);
    const db = await getOrganizerDB();
    await db.put(store, {
        ...record,
        encryptedData: encrypted.encryptedData,
        decryptionHeader: encrypted.decryptionHeader,
    } as Parameters<typeof db.put<typeof store>>[1]);
};

/**
 * Decrypt the chunk rows accepted by `accept`, in chunk id order (IndexedDB
 * key order), so callers can apply later chunks over earlier ones.
 */
const loadChunks = async <T>(
    store: ChunkStore,
    cacheKey: string,
    accept: (record: { modelId?: string; dims?: number }) => boolean = () =>
        true,
): Promise<T[]> => {
    const db = await getOrganizerDB();
    const records = await db.getAll(store);
    return Promise.all(
        records
            .filter(accept)
            .map((record) =>
                decryptCachePayload<T>(
                    {
                        encryptedData: record.encryptedData,
                        decryptionHeader: record.decryptionHeader,
                    },
                    cacheKey,
                )),
    );
};

/**
 * Load the phash chunk meta. Older monolithic indexes (v3 and below) hold
 * point-sampled hashes that no longer compare against current ones, so they
 * read as absent and the caller rescans.
 */
export const loadPhashMeta = async (
    cacheKey: string,
): Promise<PersistedPhashMeta | undefined> => {
    const meta = await loadKv("phashIndex", cacheKey);
    return meta?.version === 4 ? (meta as PersistedPhashMeta) : undefined;
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
    const payload: PhashChunkPayload = {
        entries: Object.fromEntries(entries),
    };
    await appendChunk(
        "phashChunks",
        { chunkId: meta.nextChunkId },
        payload,
        cacheKey,
    );
    const nextMeta: PersistedPhashMeta = {
        version: 4,
        nextChunkId: meta.nextChunkId + 1,
    };
    await saveKv("phashIndex", nextMeta, cacheKey);
};

/** Read every phash chunk, applying later chunks (and removals) over earlier ones. */
export const loadAllPhashChunks = async (
    cacheKey: string,
): Promise<Map<number, PhashEntry>> => {
    const payloads = await loadChunks<PhashChunkPayload>(
        "phashChunks",
        cacheKey,
    );
    const entries = new Map<number, PhashEntry>();
    for (const payload of payloads) {
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
    await saveKv("phashIndex", meta, cacheKey);
};

export const loadEmbeddingMeta = async (
    cacheKey: string,
): Promise<PersistedEmbeddingMeta | undefined> => {
    const parsed = await loadKv("embeddingIndex", cacheKey);
    return parsed?.version === 2 ? parsed : undefined;
};

export const saveEmbeddingMeta = (
    meta: PersistedEmbeddingMeta,
    cacheKey: string,
): Promise<void> => saveKv("embeddingIndex", meta, cacheKey);

export const clearEmbeddingChunks = async (): Promise<void> => {
    const db = await getOrganizerDB();
    await db.clear("embeddingChunks");
};

let embeddingAppends: Promise<void> = Promise.resolve();

/**
 * Encrypt and append one embedding chunk; a `null` entry removes that file.
 * Accepts packed or plain vectors — disk payload is always number[].
 *
 * [Note: Serialized embedding chunk appends]
 *
 * CLIP scans, the mldata pull and edits all append chunks. Appends run one at
 * a time and take the chunk id from the stored meta, because a writer holding
 * its own copy of the meta reuses ids, and `put` on a reused id silently
 * replaces (drops) the earlier chunk.
 *
 * @throws when no embedding meta is stored (see `ensureEmbeddingMeta`).
 */
export const appendEmbeddingChunk = (
    entries: ReadonlyMap<number, ArrayLike<number> | null>,
    cacheKey: string,
): Promise<void> => {
    if (entries.size === 0) {
        return Promise.resolve();
    }
    const append = embeddingAppends.then(async () => {
        const meta = await loadEmbeddingMeta(cacheKey);
        if (!meta) {
            throw new Error("Embedding index meta missing");
        }
        const jsonEntries: Record<number, number[] | null> = {};
        for (const [fileId, vector] of entries) {
            jsonEntries[fileId] = vector === null || Array.isArray(vector) ?
                vector :
                Array.from(vector);
        }
        const payload: EmbeddingChunkPayload = {
            entries: jsonEntries,
        };
        await appendChunk(
            "embeddingChunks",
            { chunkId: meta.nextChunkId, modelId: meta.modelId, dims: meta.dims },
            payload,
            cacheKey,
        );
        await saveEmbeddingMeta(
            { ...meta, nextChunkId: meta.nextChunkId + 1 },
            cacheKey,
        );
    });
    embeddingAppends = append.catch(() => undefined);
    return append;
};

/**
 * Decrypt all chunks for the given model and merge into a packed map,
 * applying later chunks (and removals) over earlier ones.
 */
export const loadAllEmbeddingChunks = async (
    meta: PersistedEmbeddingMeta,
    cacheKey: string,
): Promise<Map<number, Float32Array>> => {
    const payloads = await loadChunks<EmbeddingChunkPayload>(
        "embeddingChunks",
        cacheKey,
        (record) => record.modelId === meta.modelId && record.dims === meta.dims,
    );
    const map = new Map<number, Float32Array>();
    for (const payload of payloads) {
        for (const [id, vector] of Object.entries(payload.entries)) {
            if (vector === null) {
                map.delete(Number(id));
            } else if (Array.isArray(vector) && vector.length === meta.dims) {
                map.set(Number(id), Float32Array.from(vector));
            }
        }
    }
    return map;
};
