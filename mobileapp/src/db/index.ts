import { deleteDB, openDB, type IDBPDatabase } from "idb";

const dbVersion = 1;

export type KvKey = "collections" | "files" | "tagIndex" | "phashIndex";

export interface KvRecord {
    key: KvKey;
    encryptedData: string;
    decryptionHeader: string;
}

export interface ThumbnailRecord {
    fileId: number;
    encryptedData: string;
    decryptionHeader: string;
}

export interface SyncCursorRecord {
    collectionId: number;
    sinceTime: number;
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
    syncCursors: {
        key: number;
        value: SyncCursorRecord;
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
            if (!db.objectStoreNames.contains("syncCursors")) {
                db.createObjectStore("syncCursors", { keyPath: "collectionId" });
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
 * Return true if encrypted file metadata exists on disk for a user.
 */
export const hasCachedLibrary = async (userId: number): Promise<boolean> => {
    const db = await openOrganizerDB(userId);
    const record = await db.get("kv", "files");
    await db.close();
    return record !== undefined;
};
