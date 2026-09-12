/**
 * Sharded encrypted library cache — fileId%64 buckets so tag/favourite
 * saves rewrite one small blob instead of the full EnteFile[].
 *
 * [Note: Library file shards] Membership is stable by file id modulus.
 * Call {@link markLibraryCacheFilesDirty} for optimistic edits that keep the
 * same {@link EnteFile.updationTime} (tags, visibility). Sync-driven changes
 * are detected via updationTime. Never fingerprint the whole library with
 * JSON.stringify — that froze tagging on large libraries.
 */

import type { EnteFile } from "ente-media/file";
import {
    decryptCachePayload,
    encryptCachePayload,
    type EncryptedPayload,
} from "./crypto";
import { getOrganizerDB, type FileShardRecord } from "./index";

/** Fixed bucket count — ~500 files/shard around a 32k library. */
export const FILE_LIBRARY_SHARD_COUNT = 64;

export const FILE_SHARDS_META_VERSION = 1 as const;

export type FileShardsMeta = {
    version: typeof FILE_SHARDS_META_VERSION;
    shardCount: number;
};

const shardsMetaKey = "file-shards-meta";

/** Last persisted id → updationTime (sync / structural dirty detection). */
let lastPersistedUpdation = new Map<number, number>();

/** Optimistic local edits that did not bump updationTime. */
let pendingDirtyFileIds = new Set<number>();

let pendingDirtyAll = false;

/**
 * Stable shard bucket for a file id.
 */
export const fileLibraryShardId = (
    fileId: number,
    shardCount: number = FILE_LIBRARY_SHARD_COUNT,
): number => {
    const count = shardCount > 0 ? shardCount : FILE_LIBRARY_SHARD_COUNT;
    return ((fileId % count) + count) % count;
};

/**
 * Drop in-memory dirty baseline (logout / DB wipe).
 */
export const clearFileShardPersistState = (): void => {
    lastPersistedUpdation = new Map();
    pendingDirtyFileIds = new Set();
    pendingDirtyAll = false;
};

/**
 * Mark files whose local metadata changed without a new updationTime (tags,
 * archive, etc.) so the next save rewrites their shards.
 */
export const markLibraryCacheFilesDirty = (
    fileIds: Iterable<number>,
): void => {
    for (const fileId of fileIds) {
        pendingDirtyFileIds.add(fileId);
    }
};

/**
 * Force every non-empty shard to rewrite on the next save.
 */
export const markLibraryCacheFullyDirty = (): void => {
    pendingDirtyAll = true;
};

const loadShardsMeta = async (): Promise<FileShardsMeta | undefined> => {
    const db = await getOrganizerDB();
    const raw = await db.get("meta", shardsMetaKey);
    if (typeof raw !== "string" || raw.length === 0) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as FileShardsMeta;
        if (
            parsed?.version !== FILE_SHARDS_META_VERSION ||
            typeof parsed.shardCount !== "number" ||
            parsed.shardCount <= 0
        ) {
            return undefined;
        }
        return parsed;
    } catch {
        return undefined;
    }
};

const saveShardsMeta = async (meta: FileShardsMeta): Promise<void> => {
    const db = await getOrganizerDB();
    await db.put("meta", JSON.stringify(meta), shardsMetaKey);
};

const groupFilesByShard = (
    files: readonly EnteFile[],
    shardCount: number,
): Map<number, EnteFile[]> => {
    const groups = new Map<number, EnteFile[]>();
    for (const file of files) {
        const shardId = fileLibraryShardId(file.id, shardCount);
        const list = groups.get(shardId);
        if (list) {
            list.push(file);
        } else {
            groups.set(shardId, [file]);
        }
    }
    return groups;
};

/**
 * Shards dirty from updationTime / membership changes (not optimistic tags).
 */
export const dirtyFileShardIdsFromUpdation = (
    files: readonly EnteFile[],
    shardCount: number,
    previous: ReadonlyMap<number, number>,
): Set<number> => {
    const dirty = new Set<number>();
    const nextIds = new Set<number>();

    for (const file of files) {
        nextIds.add(file.id);
        const prev = previous.get(file.id);
        if (prev === undefined || prev !== file.updationTime) {
            dirty.add(fileLibraryShardId(file.id, shardCount));
        }
    }
    for (const [fileId] of previous) {
        if (!nextIds.has(fileId)) {
            dirty.add(fileLibraryShardId(fileId, shardCount));
        }
    }
    return dirty;
};

/**
 * Combine updationTime dirty set with explicitly marked optimistic file ids.
 */
export const resolveDirtyFileShardIds = (
    files: readonly EnteFile[],
    shardCount: number,
    previous: ReadonlyMap<number, number>,
    markedFileIds: ReadonlySet<number>,
    forceAll: boolean,
): Set<number> => {
    if (forceAll || previous.size === 0) {
        const all = new Set<number>();
        for (const file of files) {
            all.add(fileLibraryShardId(file.id, shardCount));
        }
        for (const fileId of previous.keys()) {
            all.add(fileLibraryShardId(fileId, shardCount));
        }
        return all;
    }
    const dirty = dirtyFileShardIdsFromUpdation(files, shardCount, previous);
    for (const fileId of markedFileIds) {
        dirty.add(fileLibraryShardId(fileId, shardCount));
    }
    return dirty;
};

const snapshotUpdation = (
    files: readonly EnteFile[],
): Map<number, number> => {
    const map = new Map<number, number>();
    for (const file of files) {
        map.set(file.id, file.updationTime);
    }
    return map;
};

const putShard = async (
    shardId: number,
    files: EnteFile[],
    cacheKey: string,
): Promise<void> => {
    const encrypted = await encryptCachePayload(files, cacheKey);
    const db = await getOrganizerDB();
    await db.put("fileShards", {
        shardId,
        encryptedData: encrypted.encryptedData,
        decryptionHeader: encrypted.decryptionHeader,
    });
};

const deleteShard = async (shardId: number): Promise<void> => {
    const db = await getOrganizerDB();
    await db.delete("fileShards", shardId);
};

const loadAllShardRecords = async (): Promise<FileShardRecord[]> => {
    const db = await getOrganizerDB();
    return db.getAll("fileShards");
};

const decryptShardFiles = async (
    record: FileShardRecord,
    cacheKey: string,
): Promise<EnteFile[]> => {
    const payload: EncryptedPayload = {
        encryptedData: record.encryptedData,
        decryptionHeader: record.decryptionHeader,
    };
    const files = await decryptCachePayload<EnteFile[]>(payload, cacheKey);
    return Array.isArray(files) ? files : [];
};

/**
 * Load library files from shards (migrating legacy monolith once if needed).
 */
export const loadEncryptedFilesSharded = async (
    cacheKey: string,
): Promise<EnteFile[] | undefined> => {
    const records = await loadAllShardRecords();
    if (records.length > 0) {
        const files: EnteFile[] = [];
        for (const record of records) {
            files.push(...(await decryptShardFiles(record, cacheKey)));
        }
        lastPersistedUpdation = snapshotUpdation(files);
        pendingDirtyFileIds = new Set();
        pendingDirtyAll = false;
        const meta = await loadShardsMeta();
        if (!meta) {
            await saveShardsMeta({
                version: FILE_SHARDS_META_VERSION,
                shardCount: FILE_LIBRARY_SHARD_COUNT,
            });
        }
        return files;
    }

    const db = await getOrganizerDB();
    const legacy = await db.get("kv", "files");
    if (!legacy) {
        lastPersistedUpdation = new Map();
        return undefined;
    }
    const files = await decryptCachePayload<EnteFile[]>(
        {
            encryptedData: legacy.encryptedData,
            decryptionHeader: legacy.decryptionHeader,
        },
        cacheKey,
    );
    if (!Array.isArray(files)) {
        lastPersistedUpdation = new Map();
        return undefined;
    }
    await saveEncryptedFilesSharded(files, cacheKey, { forceAllShards: true });
    await db.delete("kv", "files");
    return files;
};

export type SaveEncryptedFilesOptions = {
    /** Rewrite every shard that has files (and delete empties). */
    forceAllShards?: boolean;
};

/**
 * Persist library files; only encrypts shards whose membership/updation/marks changed.
 */
export const saveEncryptedFilesSharded = async (
    files: EnteFile[],
    cacheKey: string,
    options?: SaveEncryptedFilesOptions,
): Promise<void> => {
    const shardCount = FILE_LIBRARY_SHARD_COUNT;
    await saveShardsMeta({
        version: FILE_SHARDS_META_VERSION,
        shardCount,
    });

    const groups = groupFilesByShard(files, shardCount);
    const marked = pendingDirtyFileIds;
    const forceAll = Boolean(options?.forceAllShards) || pendingDirtyAll;
    pendingDirtyFileIds = new Set();
    pendingDirtyAll = false;

    const dirty = resolveDirtyFileShardIds(
        files,
        shardCount,
        lastPersistedUpdation,
        marked,
        forceAll,
    );

    if (options?.forceAllShards || forceAll) {
        const existing = await loadAllShardRecords();
        for (const record of existing) {
            if (!groups.has(record.shardId)) {
                dirty.add(record.shardId);
            }
        }
    }

    if (dirty.size === 0) {
        return;
    }

    for (const shardId of dirty) {
        const group = groups.get(shardId);
        if (!group || group.length === 0) {
            await deleteShard(shardId);
        } else {
            await putShard(shardId, group, cacheKey);
        }
    }

    const db = await getOrganizerDB();
    if (await db.get("kv", "files")) {
        await db.delete("kv", "files");
    }

    lastPersistedUpdation = snapshotUpdation(files);
};
