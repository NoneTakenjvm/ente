import { deleteDB, openDB, type IDBPDatabase, type StoreNames } from "idb";

const dbVersion = 10;

export type KvKey =
    | "collections" |
    "tagIndex" |
    "phashIndex" |
    "qualityIndex" |
    "similarExemptions" |
    "embeddingIndex" |
    "tagOutbox" |
    "favoriteOutbox" |
    "favoriteMembership" |
    "visibilityOutbox" |
    "derivedReplaceOutbox" |
    "trashItems" |
    "trashCollectionKeys" |
    "viewSessions";

interface KvRecord {
    key: KvKey;
    encryptedData: string;
    decryptionHeader: string;
}

export interface ThumbnailRecord {
    fileId: number;
    encryptedData: ArrayBuffer;
    decryptionHeader: string;
    /** Ciphertext byte length. */
    byteSize: number;
    /** LRU touch time. */
    lastAccess: number;
}

/**
 * Full-file video bytes on disk: Ente server ciphertext wrapped again with the
 * session {@code cacheKey}. Without login (no cacheKey / file.key) the blob is
 * opaque. {@link decryptionHeader} is the cacheKey layer; {@link fileDecryptionHeader}
 * is the original stream header for {@code file.key}.
 */
export interface FileCiphertextRecord {
    fileId: number;
    encryptedData: ArrayBuffer;
    decryptionHeader: string;
    fileDecryptionHeader: string;
    byteSize: number;
    lastAccess: number;
}

/**
 * Pending derived-replace media bytes (crop/compress/video-edit), stored as
 * ArrayBuffer so large videos are not base64'd into the encrypted kv blob.
 */
export interface DerivedReplacePayloadRecord {
    fileId: number;
    /** Edited file bytes encrypted with the session cacheKey. */
    encryptedData: ArrayBuffer;
    decryptionHeader: string;
    byteSize: number;
}

interface SyncCursorRecord {
    collectionId: number;
    sinceTime: number;
}

/** One encrypted CLIP embedding chunk (append-only during scan). */
interface EmbeddingChunkRecord {
    chunkId: number;
    modelId: string;
    dims: number;
    encryptedData: string;
    decryptionHeader: string;
}

export interface FileShardRecord {
    shardId: number;
    encryptedData: string;
    decryptionHeader: string;
}

/** One encrypted chunk of phash entries (append-only; later chunks win). */
interface PhashChunkRecord {
    chunkId: number;
    encryptedData: string;
    decryptionHeader: string;
}

interface OrganizerDB {
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
    fileShards: {
        key: number;
        value: FileShardRecord;
    };
    phashChunks: {
        key: number;
        value: PhashChunkRecord;
    };
    meta: {
        key: string;
        /** Sync cursors are numbers; some flags are JSON strings. */
        value: number | string;
    };
}

const dbNameForUser = (userId: number): string =>
    `ente-organizer-${userId}`;

/** Every object store with its key path (none has secondary indexes). */
const objectStores: ReadonlyArray<
    readonly [StoreNames<OrganizerDB>, IDBObjectStoreParameters | undefined]
> = [
    ["kv", { keyPath: "key" }],
    ["thumbnails", { keyPath: "fileId" }],
    ["fileCiphertexts", { keyPath: "fileId" }],
    ["derivedReplacePayloads", { keyPath: "fileId" }],
    ["syncCursors", { keyPath: "collectionId" }],
    ["embeddingChunks", { keyPath: "chunkId" }],
    ["fileShards", { keyPath: "shardId" }],
    ["phashChunks", { keyPath: "chunkId" }],
    ["meta", undefined],
];

let activeUserId: number | undefined;
let dbPromise: Promise<IDBPDatabase<OrganizerDB>> | undefined;
const unbindListeners: Array<() => void> = [];

/** Run `listener` whenever the active DB binding is dropped (logout / wipe). */
export const onOrganizerDBUnbind = (listener: () => void): void => {
    unbindListeners.push(listener);
};

const openOrganizerDB = (userId: number): Promise<IDBPDatabase<OrganizerDB>> =>
    openDB<OrganizerDB>(dbNameForUser(userId), dbVersion, {
        upgrade(db, oldVersion, _newVersion, transaction) {
            for (const [name, options] of objectStores) {
                if (!db.objectStoreNames.contains(name)) {
                    db.createObjectStore(name, options);
                }
            }

            // v9 dropped the tile-embeddings store and legacy row formats
            // (kv "files" monolith, shards meta, thumbnail/ciphertext rows
            // without LRU fields). Caches re-pull; outboxes are untouched.
            if (oldVersion > 0 && oldVersion < 9) {
                const untypedDB = db as unknown as IDBPDatabase;
                if (untypedDB.objectStoreNames.contains("tileEmbeddings")) {
                    untypedDB.deleteObjectStore("tileEmbeddings");
                }
                void transaction.objectStore("kv").delete("files" as KvKey);
                void transaction.objectStore("meta").delete("file-shards-meta");
                void transaction.objectStore("thumbnails").clear();
                void transaction.objectStore("fileCiphertexts").clear();
            }
            // v10 stores thumbnail ciphertext as ArrayBuffer, not base64.
            if (oldVersion > 0 && oldVersion < 10) {
                void transaction.objectStore("thumbnails").clear();
            }
        },
    });

/**
 * Bind subsequent DB operations to a logged-in user.
 */
export const bindOrganizerDB = (userId: number): void => {
    if (activeUserId !== userId) {
        closeConnection(dbPromise);
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
    unbindOrganizerDB();
    await deleteDB(dbNameForUser(userId));
};

/**
 * Delete organizer data for a specific user regardless of active binding.
 */
export const wipeOrganizerDBForUser = async (userId: number): Promise<void> => {
    if (activeUserId === userId) {
        unbindOrganizerDB();
    }
    await deleteDB(dbNameForUser(userId));
};

/**
 * Drop the active binding and close its connection — an open connection
 * blocks `deleteDB` indefinitely.
 */
const unbindOrganizerDB = (): void => {
    closeConnection(dbPromise);
    dbPromise = undefined;
    activeUserId = undefined;
    for (const listener of unbindListeners) {
        listener();
    }
};

/** Close once in-flight transactions finish (IndexedDB close semantics). */
const closeConnection = (
    connection: Promise<IDBPDatabase<OrganizerDB>> | undefined,
): void => {
    void connection?.then(
        (db) => db.close(),
        () => undefined,
    );
};
