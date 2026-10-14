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
import {
    getOrganizerDB,
    onOrganizerDBUnbind,
    type FileShardRecord,
} from "./index";

/** Fixed bucket count — ~500 files/shard around a 32k library. */
export const FILE_LIBRARY_SHARD_COUNT = 64;

/** Last persisted id → updationTime (sync / structural dirty detection). */
let lastPersistedUpdation = new Map<number, number>();

/** Optimistic local edits that did not bump updationTime. */
let pendingDirtyFileIds = new Set<number>();

let pendingDirtyAll = false;

/** Saves run one at a time so a slower, older save cannot overwrite a newer shard. */
let saveChain: Promise<void> = Promise.resolve();

/**
 * Stable shard bucket for a file id.
 */
export const fileLibraryShardId = (fileId: number): number =>
    ((fileId % FILE_LIBRARY_SHARD_COUNT) + FILE_LIBRARY_SHARD_COUNT) %
    FILE_LIBRARY_SHARD_COUNT;

/**
 * Drop in-memory dirty baseline (logout / DB wipe).
 */
const clearFileShardPersistState = (): void => {
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

const groupFilesByShard = (
    files: readonly EnteFile[],
): Map<number, EnteFile[]> => {
    const groups = new Map<number, EnteFile[]>();
    for (const file of files) {
        const shardId = fileLibraryShardId(file.id);
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
    previous: ReadonlyMap<number, number>,
): Set<number> => {
    const dirty = new Set<number>();
    const nextIds = new Set<number>();

    for (const file of files) {
        nextIds.add(file.id);
        const prev = previous.get(file.id);
        if (prev === undefined || prev !== file.updationTime) {
            dirty.add(fileLibraryShardId(file.id));
        }
    }
    for (const [fileId] of previous) {
        if (!nextIds.has(fileId)) {
            dirty.add(fileLibraryShardId(fileId));
        }
    }
    return dirty;
};

/**
 * Combine updationTime dirty set with explicitly marked optimistic file ids.
 */
export const resolveDirtyFileShardIds = (
    files: readonly EnteFile[],
    previous: ReadonlyMap<number, number>,
    markedFileIds: ReadonlySet<number>,
    forceAll: boolean,
): Set<number> => {
    if (forceAll || previous.size === 0) {
        const all = new Set<number>();
        for (const file of files) {
            all.add(fileLibraryShardId(file.id));
        }
        for (const fileId of previous.keys()) {
            all.add(fileLibraryShardId(fileId));
        }
        return all;
    }
    const dirty = dirtyFileShardIdsFromUpdation(files, previous);
    for (const fileId of markedFileIds) {
        dirty.add(fileLibraryShardId(fileId));
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

/**
 * Encrypt the dirty shards, then write them (and delete emptied ones) in one
 * transaction so a failure leaves no half-written set.
 */
const writeShards = async (
    dirty: ReadonlySet<number>,
    groups: ReadonlyMap<number, EnteFile[]>,
    cacheKey: string,
): Promise<void> => {
    const writes = await Promise.all(
        [...dirty].map(async (shardId) => {
            const group = groups.get(shardId);
            if (!group || group.length === 0) {
                return { shardId, record: undefined };
            }
            const encrypted = await encryptCachePayload(group, cacheKey);
            return {
                shardId,
                record: {
                    shardId,
                    encryptedData: encrypted.encryptedData,
                    decryptionHeader: encrypted.decryptionHeader,
                },
            };
        }),
    );
    const db = await getOrganizerDB();
    const tx = db.transaction("fileShards", "readwrite");
    await Promise.all([
        ...writes.map(({ shardId, record }) =>
            record ? tx.store.put(record) : tx.store.delete(shardId)),
        tx.done,
    ]);
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
 * Load library files from shards.
 */
export const loadEncryptedFilesSharded = async (
    cacheKey: string,
): Promise<EnteFile[] | undefined> => {
    const records = await loadAllShardRecords();
    if (records.length > 0) {
        const files = (
            await Promise.all(
                records.map((record) => decryptShardFiles(record, cacheKey)),
            )
        ).flat();
        lastPersistedUpdation = snapshotUpdation(files);
        pendingDirtyFileIds = new Set();
        pendingDirtyAll = false;
        return files;
    }

    lastPersistedUpdation = new Map();
    return undefined;
};

export type SaveEncryptedFilesOptions = {
    /** Rewrite every shard that has files (and delete empties). */
    forceAllShards?: boolean;
};

/**
 * Persist library files; only encrypts shards whose membership/updation/marks changed.
 *
 * Calls are serialised — each one diffs against the previous save's result.
 */
export const saveEncryptedFilesSharded = (
    files: EnteFile[],
    cacheKey: string,
    options?: SaveEncryptedFilesOptions,
): Promise<void> => {
    const save = saveChain
        .catch(() => undefined)
        .then(() => saveChangedShards(files, cacheKey, options));
    saveChain = save;
    return save;
};

const saveChangedShards = async (
    files: EnteFile[],
    cacheKey: string,
    options?: SaveEncryptedFilesOptions,
): Promise<void> => {
    const groups = groupFilesByShard(files);
    const marked = pendingDirtyFileIds;
    const forceAll = Boolean(options?.forceAllShards) || pendingDirtyAll;
    pendingDirtyFileIds = new Set();
    pendingDirtyAll = false;

    const dirty = resolveDirtyFileShardIds(
        files,
        lastPersistedUpdation,
        marked,
        forceAll,
    );

    if (forceAll) {
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

    try {
        await writeShards(dirty, groups, cacheKey);
    } catch (error) {
        // Keep the marks so the next save retries these files.
        markLibraryCacheFilesDirty(marked);
        pendingDirtyAll ||= forceAll;
        throw error;
    }

    lastPersistedUpdation = snapshotUpdation(files);
};

onOrganizerDBUnbind(clearFileShardPersistState);
