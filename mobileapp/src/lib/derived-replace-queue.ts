import type { EnteFile } from "ente-media/file";

interface PendingDerivedReplace {
    croppedBytes: Uint8Array;
    dimensions: { width: number; height: number };
    waiters: Array<{
        resolve: (file: EnteFile) => void;
        reject: (error: Error) => void;
    }>;
}

const pendingByFileId = new Map<number, PendingDerivedReplace>();
const activeFileIds = new Set<number>();

const toError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));

const yieldToCoalesce = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

type DerivedReplaceSave = (
    bytes: Uint8Array,
    dimensions: { width: number; height: number },
) => Promise<EnteFile>;

/**
 * Queue a derived file replace per source file. Rapid saves coalesce to the
 * latest bytes; one background worker drains the queue.
 */
export const enqueueDerivedReplace = (
    fileId: number,
    croppedBytes: Uint8Array,
    dimensions: { width: number; height: number },
    save: DerivedReplaceSave,
): Promise<EnteFile> =>
    new Promise((resolve, reject) => {
        let pending = pendingByFileId.get(fileId);
        if (!pending) {
            pending = { croppedBytes, dimensions, waiters: [] };
            pendingByFileId.set(fileId, pending);
        } else {
            pending.croppedBytes = croppedBytes;
            pending.dimensions = dimensions;
        }
        pending.waiters.push({ resolve, reject });
        void drainDerivedReplaceQueue(fileId, save);
    });

const drainDerivedReplaceQueue = async (
    fileId: number,
    save: DerivedReplaceSave,
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
            const { croppedBytes, dimensions } = entry;
            try {
                const uploaded = await save(croppedBytes, dimensions);
                const stillPending = pendingByFileId.get(fileId);
                if (
                    stillPending &&
                    (stillPending.croppedBytes !== croppedBytes ||
                        stillPending.dimensions !== dimensions)
                ) {
                    continue;
                }
                const waiters = stillPending?.waiters ?? entry.waiters;
                pendingByFileId.delete(fileId);
                for (const waiter of waiters) {
                    waiter.resolve(uploaded);
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
            void drainDerivedReplaceQueue(fileId, save);
        }
    }
};
