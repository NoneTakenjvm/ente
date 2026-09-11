/**
 * Sharded encrypted library cache — fileId%64 buckets so tag/favourite
 * saves rewrite one small blob instead of the full EnteFile[].
 *
 * [Note: Library file shards] Membership is stable by file id modulus, so
 * adding/removing a file only dirties that file's shard. Full sync still
 * rewrites changed shards. Legacy monolith kv key {@code files} is migrated
 * once on load (then deleted).
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

/** Last persisted id → content fingerprint for dirty-shard detection. */
let lastPersistedFingerprints = new Map<number, string>();

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
    lastPersistedFingerprints = new Map();
};

/**
 * Fingerprint local+remote fields that must hit disk (tags often keep the same
 * {@link EnteFile.updationTime} until museum ack).
 */
export const fileLibraryPersistFingerprint = (file: EnteFile): string => {
    const pub = file.pubMagicMetadata;
    const priv = file.magicMetadata;
    return [
        file.updationTime,
        pub?.version ?? "",
        priv?.version ?? "",
        JSON.stringify(pub?.data ?? null),
        JSON.stringify(priv?.data ?? null),
    ].join("\0");
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
 * Which shard ids need a rewrite given the next library snapshot.
 */
export const dirtyFileShardIds = (
    files: readonly EnteFile[],
    shardCount: number,
    previous: ReadonlyMap<number, string>,
): Set<number> => {
    const dirty = new Set<number>();
    const nextIds = new Set<number>();

    for (const file of files) {
        nextIds.add(file.id);
        const prev = previous.get(file.id);
        if (
            prev === undefined ||
            prev !== fileLibraryPersistFingerprint(file)
        ) {
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

const snapshotFingerprints = (
    files: readonly EnteFile[],
): Map<number, string> => {
    const map = new Map<number, string>();
    for (const file of files) {
        map.set(file.id, fileLibraryPersistFingerprint(file));
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
        lastPersistedFingerprints = snapshotFingerprints(files);
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
        lastPersistedFingerprints = new Map();
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
        lastPersistedFingerprints = new Map();
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
 * Persist library files; only encrypts shards whose membership/updation changed.
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
    let dirty: Set<number>;
    if (options?.forceAllShards) {
        dirty = new Set(groups.keys());
        const existing = await loadAllShardRecords();
        for (const record of existing) {
            if (!groups.has(record.shardId)) {
                dirty.add(record.shardId);
            }
        }
    } else {
        dirty = dirtyFileShardIds(
            files,
            shardCount,
            lastPersistedFingerprints,
        );
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

    lastPersistedFingerprints = snapshotFingerprints(files);
};
