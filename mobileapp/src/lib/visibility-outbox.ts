import type { EnteFile } from "ente-media/file";
import { ItemVisibility, isArchivedFile } from "ente-media/file-metadata";
import { createOutbox } from "@/lib/outbox";

export interface VisibilityOutboxEntry {
    fileId: number;
    visibility: ItemVisibility;
    enqueuedAt: number;
}

const outbox = createOutbox<VisibilityOutboxEntry, number>({
    kvKey: "visibilityOutbox",
    keyOf: (entry) => entry.fileId,
    label: "Visibility outbox",
    sameIntent: (current, sent) => current.visibility === sent.visibility,
});

export const hydrateVisibilityOutbox = outbox.hydrate;

export const ensureVisibilityOutboxHydrated = outbox.hydrate;

export const isVisibilityOutboxHydrated = outbox.isHydrated;

export const upsertVisibilityOutboxEntry = (
    fileId: number,
    visibility: ItemVisibility,
): Promise<void> =>
    outbox.upsert([{ fileId, visibility, enqueuedAt: Date.now() }]);

export const removeVisibilityOutboxEntries = async (
    fileIds: number[],
): Promise<void> => {
    if (!fileIds.length) {
        return;
    }
    const idSet = new Set(fileIds);
    await outbox.removeWhere((entry) => idSet.has(entry.fileId));
};

/**
 * Remove the entry for `sent`'s file only if it is still the entry that was
 * sent, so a newer archive intent queued mid-flight survives the ack.
 */
export const removeVisibilityOutboxEntryIfUnchanged = (
    sent: VisibilityOutboxEntry,
): Promise<void> => outbox.removeIfUnchanged([sent]);

export const getVisibilityOutboxEntries = outbox.entries;

/**
 * True when the file is archived on disk or via a pending visibility outbox entry.
 */
export const isFileArchivedLocally = (file: EnteFile): boolean => {
    const pending = outbox.get(file.id);
    if (pending) {
        return pending.visibility === ItemVisibility.archived;
    }
    return isArchivedFile(file);
};

export const remapVisibilityOutboxFileId = (
    fromFileId: number,
    toFileId: number,
): Promise<void> =>
    outbox.remap(fromFileId, toFileId, (entry) => ({
        ...entry,
        fileId: toFileId,
    }));

export const reconcileVisibilityOutboxWithFiles = async (
    files: EnteFile[],
): Promise<void> => {
    if (outbox.size() === 0) {
        return;
    }
    const filesById = new Map(files.map((file) => [file.id, file]));
    const verifiedIds: number[] = [];
    for (const entry of outbox.entries()) {
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
    await removeVisibilityOutboxEntries(verifiedIds);
};

/**
 * Apply pending archive intents onto files for local display.
 */
export const applyOutboxVisibilityToFiles = (
    files: EnteFile[],
    entries: Iterable<VisibilityOutboxEntry> = outbox.entries(),
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

export const clearVisibilityOutbox = outbox.clear;

/**
 * Persist the in-memory visibility outbox to encrypted IDB.
 */
export const flushVisibilityOutboxPersist = outbox.flush;
