import type { EnteFile } from "ente-media/file";
import {
    loadEncryptedTagOutbox,
    saveEncryptedTagOutbox,
    type PersistedTagOutboxEntry,
} from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";
import { fileWithOrganizerTags } from "@/lib/tag-writes";

export interface TagOutboxEntry {
    fileId: number;
    intendedTags: string[];
    enqueuedAt: number;
}

const outboxByFileId = new Map<number, TagOutboxEntry>();
let persistScheduled = false;
let hydrated = false;

const toPersisted = (entry: TagOutboxEntry): PersistedTagOutboxEntry => ({
    fileId: entry.fileId,
    intendedTags: entry.intendedTags,
    enqueuedAt: entry.enqueuedAt,
});

const schedulePersist = (): void => {
    if (persistScheduled) {
        return;
    }
    persistScheduled = true;
    setTimeout(() => {
        persistScheduled = false;
        void flushTagOutboxToDisk();
    }, 0);
};

const flushTagOutboxToDisk = async (): Promise<void> => {
    const entries = [...outboxByFileId.values()].map(toPersisted);
    await saveEncryptedTagOutbox(entries, getSessionCacheKey());
};

/**
 * Load the encrypted tag outbox from IndexedDB into memory.
 */
export const hydrateTagOutbox = async (): Promise<void> => {
    const persisted = await loadEncryptedTagOutbox(getSessionCacheKey());
    outboxByFileId.clear();
    for (const entry of persisted ?? []) {
        outboxByFileId.set(entry.fileId, entry);
    }
    hydrated = true;
};

export const isTagOutboxHydrated = (): boolean => hydrated;

/**
 * Queue or replace a pending tag write for a file.
 */
export const upsertTagOutboxEntry = async (
    fileId: number,
    intendedTags: string[],
): Promise<void> => {
    if (!hydrated) {
        await hydrateTagOutbox();
    }
    outboxByFileId.set(fileId, {
        fileId,
        intendedTags,
        enqueuedAt: Date.now(),
    });
    schedulePersist();
};

/**
 * Remove one or more files from the outbox after verified remote sync.
 */
export const removeTagOutboxEntries = async (
    fileIds: number[],
): Promise<void> => {
    if (!fileIds.length) {
        return;
    }
    for (const fileId of fileIds) {
        outboxByFileId.delete(fileId);
    }
    await flushTagOutboxToDisk();
};

export const getTagOutboxEntries = (): TagOutboxEntry[] =>
    [...outboxByFileId.values()];

export const getTagOutboxEntry = (
    fileId: number,
): TagOutboxEntry | undefined => outboxByFileId.get(fileId);

/**
 * Apply pending outbox tag intents onto a file list for display and indexing.
 */
export const applyOutboxTagsToFiles = (
    files: EnteFile[],
    entries: Iterable<TagOutboxEntry> = outboxByFileId.values(),
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

export const clearTagOutbox = (): void => {
    outboxByFileId.clear();
    hydrated = false;
    persistScheduled = false;
};
