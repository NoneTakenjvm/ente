import type { EnteFile } from "ente-media/file";
import { ItemVisibility, isArchivedFile } from "ente-media/file-metadata";
import {
    loadEncryptedVisibilityOutbox,
    saveEncryptedVisibilityOutbox,
    type PersistedVisibilityOutboxEntry,
} from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";

export interface VisibilityOutboxEntry {
    fileId: number;
    visibility: ItemVisibility;
    enqueuedAt: number;
}

const outboxByFileId = new Map<number, VisibilityOutboxEntry>();
let hydrated = false;
let persistChain: Promise<void> = Promise.resolve();

const toPersisted = (
    entry: VisibilityOutboxEntry,
): PersistedVisibilityOutboxEntry => ({
    fileId: entry.fileId,
    visibility: entry.visibility,
    enqueuedAt: entry.enqueuedAt,
});

const flushVisibilityOutboxToDisk = async (): Promise<void> => {
    const entries = [...outboxByFileId.values()].map(toPersisted);
    await saveEncryptedVisibilityOutbox(entries, getSessionCacheKey());
};

const persistVisibilityOutbox = (): Promise<void> => {
    persistChain = persistChain.then(() => flushVisibilityOutboxToDisk());
    return persistChain;
};

export const hydrateVisibilityOutbox = async (): Promise<void> => {
    const persisted = await loadEncryptedVisibilityOutbox(getSessionCacheKey());
    outboxByFileId.clear();
    for (const entry of persisted ?? []) {
        outboxByFileId.set(entry.fileId, {
            fileId: entry.fileId,
            visibility: entry.visibility as ItemVisibility,
            enqueuedAt: entry.enqueuedAt,
        });
    }
    hydrated = true;
};

export const ensureVisibilityOutboxHydrated = async (): Promise<void> => {
    if (hydrated) {
        return;
    }
    await hydrateVisibilityOutbox();
};

export const isVisibilityOutboxHydrated = (): boolean => hydrated;

export const upsertVisibilityOutboxEntry = async (
    fileId: number,
    visibility: ItemVisibility,
): Promise<void> => {
    if (!hydrated) {
        await hydrateVisibilityOutbox();
    }
    outboxByFileId.set(fileId, {
        fileId,
        visibility,
        enqueuedAt: Date.now(),
    });
    await persistVisibilityOutbox();
};

export const removeVisibilityOutboxEntries = async (
    fileIds: number[],
): Promise<void> => {
    if (!fileIds.length) {
        return;
    }
    for (const fileId of fileIds) {
        outboxByFileId.delete(fileId);
    }
    await persistVisibilityOutbox();
};

export const getVisibilityOutboxEntries = (): VisibilityOutboxEntry[] =>
    [...outboxByFileId.values()];

export const getVisibilityOutboxEntry = (
    fileId: number,
): VisibilityOutboxEntry | undefined => outboxByFileId.get(fileId);

/**
 * True when the file is archived on disk or via a pending visibility outbox entry.
 */
export const isFileArchivedLocally = (file: EnteFile): boolean => {
    const pending = outboxByFileId.get(file.id);
    if (pending) {
        return pending.visibility === ItemVisibility.archived;
    }
    return isArchivedFile(file);
};

export const remapVisibilityOutboxFileId = async (
    fromFileId: number,
    toFileId: number,
): Promise<void> => {
    if (!hydrated) {
        await hydrateVisibilityOutbox();
    }
    const existing = outboxByFileId.get(fromFileId);
    if (!existing) {
        return;
    }
    outboxByFileId.delete(fromFileId);
    outboxByFileId.set(toFileId, { ...existing, fileId: toFileId });
    await persistVisibilityOutbox();
};

export const reconcileVisibilityOutboxWithFiles = async (
    files: EnteFile[],
): Promise<void> => {
    if (outboxByFileId.size === 0) {
        return;
    }
    const filesById = new Map(files.map((file) => [file.id, file]));
    const verifiedIds: number[] = [];
    for (const entry of outboxByFileId.values()) {
        const file = filesById.get(entry.fileId);
        if (!file) {
            continue;
        }
        const archived = isArchivedFile(file);
        const intendedArchived = entry.visibility === ItemVisibility.archived;
        if (archived === intendedArchived) {
            verifiedIds.push(entry.fileId);
        }
    }
    if (verifiedIds.length > 0) {
        await removeVisibilityOutboxEntries(verifiedIds);
    }
};

/**
 * Apply pending archive intents onto files for local display.
 */
export const applyOutboxVisibilityToFiles = (
    files: EnteFile[],
    entries: Iterable<VisibilityOutboxEntry> = outboxByFileId.values(),
): EnteFile[] => {
    const byFileId = new Map<number, VisibilityOutboxEntry>();
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
        return {
            ...file,
            magicMetadata: {
                version: file.magicMetadata?.version ?? 1,
                count: file.magicMetadata?.count ?? 0,
                data: {
                    ...file.magicMetadata?.data,
                    visibility: entry.visibility,
                },
            },
        };
    });
};

export const clearVisibilityOutbox = (): void => {
    outboxByFileId.clear();
    hydrated = false;
    persistChain = Promise.resolve();
};
