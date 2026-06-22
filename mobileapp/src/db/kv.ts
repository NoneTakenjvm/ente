import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import type { PersistedTagTypeConfig } from "@/lib/tag-types";import {
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

export const loadEncryptedTagTypes = async (
    cacheKey: string,
): Promise<PersistedTagTypeConfig | undefined> => {
    const payload = await getEncrypted("tagTypes");
    if (!payload) {
        return undefined;
    }
    return decryptCachePayload<PersistedTagTypeConfig>(payload, cacheKey);
};

export const saveEncryptedTagTypes = async (
    config: PersistedTagTypeConfig,
    cacheKey: string,
): Promise<void> => {    await putEncrypted(
        "tagTypes",
        await encryptCachePayload(config, cacheKey),
    );
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
