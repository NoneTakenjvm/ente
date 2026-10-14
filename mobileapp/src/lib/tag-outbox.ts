import type { EnteFile } from "ente-media/file";
import type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
import { createOutbox, overlayFiles } from "@/lib/outbox";
import { flushTagOutboxNow, requestTagOutboxFlush } from "@/lib/outbox-runner";
import { extractTags } from "@/lib/tags";
import {
    fileWithOrganizerTags,
    tagsEqual,
    tagsForFile,
    type OrganizerPublicMetadata,
    type TagMutator,
} from "@/lib/tag-writes";

export interface BatchTagResult {
    succeeded: number;
    failed: number;
    errors: string[];
}

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
 * Queue `mutator`'s result as each file's intended tags.
 *
 * With `wait`, persists the intents and awaits a full outbox drain (batched
 * PUTs), reporting files still pending afterwards; Manage rename/delete/merge
 * use this because the UI waits on completion. Without it, enqueues in memory,
 * schedules a debounced flush and returns at once; failures surface later via
 * the runner toasts.
 */
export const queueTagMutation = async (
    files: EnteFile[],
    mutator: TagMutator,
    options: {
        wait: boolean;
        onProgress?: (completed: number, total: number) => void;
    },
): Promise<BatchTagResult> => {
    const { wait, onProgress } = options;
    if (!files.length) {
        return { succeeded: 0, failed: 0, errors: [] };
    }
    const entries = files.map((file) => ({
        fileId: file.id,
        intendedTags: tagsForFile(file, mutator),
    }));
    if (!wait) {
        enqueueTagOutboxEntries(entries);
        requestTagOutboxFlush();
        onProgress?.(files.length, files.length);
        return { succeeded: files.length, failed: 0, errors: [] };
    }

    await upsertTagOutboxEntries(entries);
    onProgress?.(0, files.length);
    await flushTagOutboxNow({ notify: false });

    const targetIds = new Set(files.map((file) => file.id));
    const pendingIds = outbox
        .entries()
        .map((entry) => entry.fileId)
        .filter((fileId) => targetIds.has(fileId));
    onProgress?.(files.length - pendingIds.length, files.length);
    return {
        succeeded: files.length - pendingIds.length,
        failed: pendingIds.length,
        errors: pendingIds.map((fileId) => `${fileId}: sync pending`),
    };
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
    return overlayFiles(files, entries, (file, entry) =>
        fileWithOrganizerTags(file, entry.intendedTags));
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
