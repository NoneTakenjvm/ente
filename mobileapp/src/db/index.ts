import { deleteDB, openDB, type IDBPDatabase } from "idb";

const dbVersion = 6;

export type KvKey =
    | "collections" |
    "files" |
    "tagIndex" |
    "phashIndex" |
    "embeddingIndex" |
    "tagOutbox" |
    "favoriteOutbox" |
    "visibilityOutbox" |
    "derivedReplaceOutbox" |
    "trashItems" |
    "trashCollectionKeys" |
    "viewSessions";

export interface KvRecord {
    key: KvKey;
    encryptedData: string;
    decryptionHeader: string;
}

export interface ThumbnailRecord {
    fileId: number;
    encryptedData: string;
    decryptionHeader: string;
    /** Ciphertext byte length (missing on legacy rows). */
    byteSize?: number;
    /** LRU touch time (missing on legacy rows). */
    lastAccess?: number;
}

/**
 * Full-file video bytes on disk: Ente server ciphertext wrapped again with the
 * session {@code cacheKey}. Without login (no cacheKey / file.key) the blob is
 * opaque. {@link decryptionHeader} is the cacheKey layer; {@link fileDecryptionHeader}
 * is the original stream header for {@code file.key}.
 *
 * Legacy rows may omit {@link fileDecryptionHeader}; those are deleted on read.
 */
export interface FileCiphertextRecord {
    fileId: number;
    encryptedData: ArrayBuffer;
    decryptionHeader: string;
    fileDecryptionHeader?: string;
    byteSize: number;
    lastAccess: number;
}

/**
 * Pending derived-replace media bytes (crop/compress/video-edit), stored as
 * ArrayBuffer so large videos are not base64'd into the encrypted kv blob.
 */
export interface DerivedReplacePayloadRecord {
    fileId: number;
    bytes: ArrayBuffer;
    byteSize: number;
}

export interface SyncCursorRecord {
    collectionId: number;
    sinceTime: number;
}

/** One encrypted CLIP embedding chunk (append-only during scan). */
export interface EmbeddingChunkRecord {
    chunkId: number;
    modelId: string;
    dims: number;
    encryptedData: string;
    decryptionHeader: string;
}

/**
 * Tile CLIP vectors for one photo (kit nearness tile pilot, local builds).
 * {@link encryptedData} is the cacheKey-wrapped float32 matrix
 * `rows × columns × dims`, row-major in {@link kitTileGrid} order.
 */
export interface TileEmbeddingRecord {
    fileId: number;
    modelId: string;
    layout: string;
    rows: number;
    columns: number;
    encryptedData: ArrayBuffer;
    decryptionHeader: string;
}

export interface OrganizerDB {
    kv: {
        key: KvKey;
        value: KvRecord;
    };
    thumbnails: {
        key: number;
        value: ThumbnailRecord;
    };
    fileCiphertexts: {
        key: number;
        value: FileCiphertextRecord;
    };
    derivedReplacePayloads: {
        key: number;
        value: DerivedReplacePayloadRecord;
    };
    syncCursors: {
        key: number;
        value: SyncCursorRecord;
    };
    embeddingChunks: {
        key: number;
        value: EmbeddingChunkRecord;
    };
    tileEmbeddings: {
        key: number;
        value: TileEmbeddingRecord;
    };
    meta: {
        key: string;
        value: number;
    };
}

const dbNameForUser = (userId: number): string =>
    `ente-organizer-${userId}`;

let activeUserId: number | undefined;
let dbPromise: Promise<IDBPDatabase<OrganizerDB>> | undefined;

const openOrganizerDB = (userId: number): Promise<IDBPDatabase<OrganizerDB>> =>
    openDB<OrganizerDB>(dbNameForUser(userId), dbVersion, {
        upgrade(db) {
            if (!db.objectStoreNames.contains("kv")) {
                db.createObjectStore("kv", { keyPath: "key" });
            }
            if (!db.objectStoreNames.contains("thumbnails")) {
                db.createObjectStore("thumbnails", { keyPath: "fileId" });
            }
            if (!db.objectStoreNames.contains("fileCiphertexts")) {
                db.createObjectStore("fileCiphertexts", { keyPath: "fileId" });
            }
            if (!db.objectStoreNames.contains("derivedReplacePayloads")) {
                db.createObjectStore("derivedReplacePayloads", {
                    keyPath: "fileId",
                });
            }
            if (!db.objectStoreNames.contains("syncCursors")) {
                db.createObjectStore("syncCursors", { keyPath: "collectionId" });
            }
            if (!db.objectStoreNames.contains("embeddingChunks")) {
                db.createObjectStore("embeddingChunks", { keyPath: "chunkId" });
            }
            if (!db.objectStoreNames.contains("tileEmbeddings")) {
                db.createObjectStore("tileEmbeddings", { keyPath: "fileId" });
            }
            if (!db.objectStoreNames.contains("meta")) {
                db.createObjectStore("meta");
            }
        },
    });

/**
 * Bind subsequent DB operations to a logged-in user.
 */
export const bindOrganizerDB = (userId: number): void => {
    if (activeUserId !== userId) {
        activeUserId = userId;
        dbPromise = openOrganizerDB(userId);
    }
};

export const getOrganizerDB = (): Promise<IDBPDatabase<OrganizerDB>> => {
    if (!dbPromise || activeUserId === undefined) {
        throw new Error("Organizer DB not bound — login required");
    }
    return dbPromise;
};

export const hasOrganizerDB = (): boolean => activeUserId !== undefined;

/**
 * Delete all local organizer data for the current user.
 */
export const wipeOrganizerDB = async (): Promise<void> => {
    if (activeUserId === undefined) {
        return;
    }
    const userId = activeUserId;
    dbPromise = undefined;
    activeUserId = undefined;
    await deleteDB(dbNameForUser(userId));
};

/**
 * Delete organizer data for a specific user regardless of active binding.
 */
export const wipeOrganizerDBForUser = async (userId: number): Promise<void> => {
    if (activeUserId === userId) {
        dbPromise = undefined;
        activeUserId = undefined;
    }
    await deleteDB(dbNameForUser(userId));
};

/**
 * Return true if encrypted file metadata exists on disk for a user.
 */
export const hasCachedLibrary = async (userId: number): Promise<boolean> => {
    const db = await openOrganizerDB(userId);
    const record = await db.get("kv", "files");
    await db.close();
    return record !== undefined;
};
