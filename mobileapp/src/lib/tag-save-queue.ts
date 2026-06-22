import type { EnteFile } from "ente-media/file";

interface PendingTagSave {
    intendedTags: string[];
    waiters: Array<{
        resolve: (file: EnteFile) => void;
        reject: (error: Error) => void;
    }>;
}

const pendingByFileId = new Map<number, PendingTagSave>();
const activeFileIds = new Set<number>();

const toError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));

const yieldToCoalesce = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Queue a tag save per file. Rapid edits coalesce to the latest tag list;
 * one background worker drains the queue with retries.
 */
export const enqueueTagSave = (
    fileId: number,
    intendedTags: string[],
    save: (tags: string[]) => Promise<EnteFile>,
): Promise<EnteFile> =>
    new Promise((resolve, reject) => {
        let pending = pendingByFileId.get(fileId);
        if (!pending) {
            pending = { intendedTags, waiters: [] };
            pendingByFileId.set(fileId, pending);
        } else {
            pending.intendedTags = intendedTags;
        }
        pending.waiters.push({ resolve, reject });
        void drainTagSaveQueue(fileId, save);
    });

const drainTagSaveQueue = async (
    fileId: number,
    save: (tags: string[]) => Promise<EnteFile>,
): Promise<void> => {
    if (activeFileIds.has(fileId)) {
        return;
    }
    activeFileIds.add(fileId);
    try {
        while (pendingByFileId.has(fileId)) {
            await yieldToCoalesce();
            const entry = pendingByFileId.get(fileId);
            if (!entry) {
                break;
            }
            const tagsToSave = entry.intendedTags;
            try {
                const updated = await save(tagsToSave);
                const stillPending = pendingByFileId.get(fileId);
                if (
                    stillPending &&
                    stillPending.intendedTags !== tagsToSave
                ) {
                    continue;
                }
                const waiters = stillPending?.waiters ?? entry.waiters;
                pendingByFileId.delete(fileId);
                for (const waiter of waiters) {
                    waiter.resolve(updated);
                }
            } catch (error) {
                const err = toError(error);
                const stillPending = pendingByFileId.get(fileId);
                const waiters = stillPending?.waiters ?? entry.waiters;
                pendingByFileId.delete(fileId);
                for (const waiter of waiters) {
                    waiter.reject(err);
                }
            }
        }
    } finally {
        activeFileIds.delete(fileId);
        if (pendingByFileId.has(fileId)) {
            void drainTagSaveQueue(fileId, save);
        }
    }
};
