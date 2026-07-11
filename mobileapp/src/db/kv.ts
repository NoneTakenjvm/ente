import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
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
    const payload = await getEncrypted("files");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<EnteFile[]>(payload, cacheKey);
};

export const saveEncryptedFiles = async (
    files: EnteFile[],
    cacheKey: string,
): Promise<void> => {
    await putEncrypted("files", await encryptCachePayload(files, cacheKey));
};

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

export interface PersistedPhashIndex {
    version: 1;
    entries: Record<number, string>;
}

export const loadEncryptedPhashIndex = async (
    cacheKey: string,
): Promise<PersistedPhashIndex | undefined> => {
    const payload = await getEncrypted("phashIndex");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<PersistedPhashIndex>(payload, cacheKey);
};

export const saveEncryptedPhashIndex = async (
    index: PersistedPhashIndex,
    cacheKey: string,
): Promise<void> => {
    await putEncrypted(
        "phashIndex",
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
    bytesBase64: string;
    width: number;
    height: number;
    kind: "crop" | "rotate" | "auto-crop" | "video-edit";
    enqueuedAt: number;
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
