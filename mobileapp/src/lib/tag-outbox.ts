import type { EnteFile } from "ente-media/file";
import type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
import { createOutbox } from "@/lib/outbox";
import { extractTags } from "@/lib/tags";
import {
    fileWithOrganizerTags,
    tagsEqual,
    type OrganizerPublicMetadata,
} from "@/lib/tag-writes";

interface TagOutboxEntry {
    fileId: number;
    intendedTags: string[];
    enqueuedAt: number;
}

const outbox = createOutbox<TagOutboxEntry, number>({
    kvKey: "tagOutbox",
    keyOf: (entry) => entry.fileId,
    label: "Tag outbox",
});

/**
 * Load the encrypted tag outbox from IndexedDB into memory.
 */
export const hydrateTagOutbox = outbox.hydrate;

/**
 * Load the outbox from disk once per session without clearing in-memory entries.
 */
export const ensureTagOutboxHydrated = outbox.hydrate;

export const isTagOutboxHydrated = outbox.isHydrated;

/**
 * Persist the in-memory outbox to encrypted IDB (page hide / before unload).
 *
 * Does not drain to the server — only makes pending intents survive a kill.
 */
export const flushTagOutboxPersist = outbox.flush;

const toOutboxEntries = (
    entries: Array<{ fileId: number; intendedTags: string[] }>,
): TagOutboxEntry[] => {
    const enqueuedAt = Date.now();
    return entries.map((entry) => ({
        fileId: entry.fileId,
        intendedTags: entry.intendedTags,
        enqueuedAt,
    }));
};

/**
 * Queue or replace pending tag writes for many files (one disk persist).
 */
export const upsertTagOutboxEntries = async (
    entries: Array<{ fileId: number; intendedTags: string[] }>,
): Promise<void> => {
    if (!entries.length) {
        return;
    }
    await outbox.upsert(toOutboxEntries(entries));
};

/**
 * Queue tag intents in memory immediately and schedule one disk persist.
 *
 * Prefer this on UI click paths — callers should not await encrypt/IDB.
 */
export const enqueueTagOutboxEntries = (
    entries: Array<{ fileId: number; intendedTags: string[] }>,
): void => {
    if (!entries.length) {
        return;
    }
    // Sets synchronously when already hydrated. Otherwise it waits on the
    // shared hydrate, so a concurrent bootstrap cannot clear what we write.
    outbox.upsert(toOutboxEntries(entries)).catch((error: unknown) => {
        console.warn("Tag outbox hydrate failed; intents not queued", error);
    });
};

/**
 * Remove one or more files from the outbox after pull confirms server tags.
 */
export const removeTagOutboxEntries = async (
    fileIds: number[],
): Promise<void> => {
    if (!fileIds.length) {
        return;
    }
    const idSet = new Set(fileIds);
    await outbox.removeWhere((entry) => idSet.has(entry.fileId));
};

export const getTagOutboxEntries = outbox.entries;

export const getTagOutboxEntry = outbox.get;

/**
 * Remap a pending tag entry when a derived replace changes the file id.
 */
export const remapTagOutboxFileId = (
    fromFileId: number,
    toFileId: number,
): Promise<void> =>
    outbox.remap(fromFileId, toFileId, (entry) => ({
        ...entry,
        fileId: toFileId,
    }));

/**
 * Drop outbox entries whose pulled server metadata already matches intent.
 */
export const reconcileTagOutboxWithFiles = async (
    files: EnteFile[],
): Promise<void> => {
    if (outbox.size() === 0) {
        return;
    }
    const filesById = new Map(files.map((file) => [file.id, file]));
    const verifiedIds: number[] = [];
    for (const entry of outbox.entries()) {
        const file = filesById.get(entry.fileId);
        if (
            file &&
            tagsEqual(extractTags(file), entry.intendedTags)
        ) {
            verifiedIds.push(entry.fileId);
        }
    }
    await removeTagOutboxEntries(verifiedIds);
};

/**
 * Apply pending outbox tag intents onto a file list for display and indexing.
 */
export const applyOutboxTagsToFiles = (
    files: EnteFile[],
    entries: Iterable<TagOutboxEntry> = outbox.entries(),
): EnteFile[] => {
    const byFileId = new Map<number, TagOutboxEntry>();
    for (const entry of entries) {
        byFileId.set(entry.fileId, entry);
    }
    if (byFileId.size === 0) {
        return files;
    }
    return files.map((file) => {
        const entry = byFileId.get(file.id);
        if (!entry) {
            return file;
        }
        return fileWithOrganizerTags(file, entry.intendedTags);
    });
};

const pubMagicVersion = (file: EnteFile): number =>
    file.pubMagicMetadata?.version && file.pubMagicMetadata.version > 0 ?
        file.pubMagicMetadata.version :
        0;

/**
 * Copy organizer tags from a live library file onto a pulled file, keeping the
 * live pub-magic version so a later PUT is not sent against a stale snapshot.
 */
const copyAheadOrganizerTags = (pulled: EnteFile, live: EnteFile): EnteFile => {
    const liveMeta = live.pubMagicMetadata;
    const pulledMeta = pulled.pubMagicMetadata;
    const liveData = liveMeta?.data as OrganizerPublicMetadata | undefined;
    const pulledData = pulledMeta?.data as OrganizerPublicMetadata | undefined;
    return {
        ...pulled,
        pubMagicMetadata: {
            version: pubMagicVersion(live) || pubMagicVersion(pulled) || 1,
            count: liveMeta?.count ?? pulledMeta?.count ?? 0,
            data: {
                ...pulledData,
                _organizer_v1: liveData?._organizer_v1,
            } as FilePublicMagicMetadataData,
        },
    };
};

/**
 * Keep local organizer-tag writes that landed (or were acked) while a pull
 * snapshot was in flight. Outbox overlays are left untouched.
 *
 * A pulled file whose live counterpart has a higher pub-magic version and
 * different tags is treated as a post-snapshot local write the pull missed.
 */
export const mergeAheadOrganizerTags = (
    pulled: EnteFile[],
    live: EnteFile[],
): EnteFile[] => {
    if (!live.length || !pulled.length) {
        return pulled;
    }
    const liveById = new Map(live.map((file) => [file.id, file]));
    let changed = false;
    const merged = pulled.map((file) => {
        if (outbox.get(file.id)) {
            return file;
        }
        const local = liveById.get(file.id);
        if (!local) {
            return file;
        }
        if (pubMagicVersion(local) <= pubMagicVersion(file)) {
            return file;
        }
        if (tagsEqual(extractTags(local), extractTags(file))) {
            return file;
        }
        changed = true;
        return copyAheadOrganizerTags(file, local);
    });
    return changed ? merged : pulled;
};

export const clearTagOutbox = outbox.clear;
