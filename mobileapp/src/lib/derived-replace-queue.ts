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

/**
 * Persist derived bytes for {@link replaceFileId}. When a newer crop arrives
 * mid-upload, the queue calls this again with the previous upload's id so the
 * intermediate file is trashed instead of left as a duplicate.
 */
export type DerivedReplaceSave = (
    bytes: Uint8Array,
    dimensions: { width: number; height: number },
    replaceFileId: number,
) => Promise<EnteFile>;

export interface EnqueueDerivedReplaceOptions {
    /**
     * Runs after the final successful save and before waiters resolve, so
     * outbox cleanup cannot race a concurrent drain retry.
     */
    onCompleted?: (uploaded: EnteFile) => Promise<void>;
}

/**
 * True while this source file id has a queued or in-flight derived replace.
 * Outbox drains should skip these — the live queue owns completion.
 */
export const isDerivedReplaceInFlight = (fileId: number): boolean =>
    pendingByFileId.has(fileId) || activeFileIds.has(fileId);

/**
 * Queue a derived file replace per source file. Rapid saves coalesce to the
 * latest bytes; one background worker drains the queue.
 */
export const enqueueDerivedReplace = (
    fileId: number,
    croppedBytes: Uint8Array,
    dimensions: { width: number; height: number },
    save: DerivedReplaceSave,
    options?: EnqueueDerivedReplaceOptions,
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
        void drainDerivedReplaceQueue(fileId, save, options);
    });

const drainDerivedReplaceQueue = async (
    fileId: number,
    save: DerivedReplaceSave,
    options?: EnqueueDerivedReplaceOptions,
    initialReplaceFileId: number = fileId,
): Promise<void> => {
    if (activeFileIds.has(fileId)) {
        return;
    }
    activeFileIds.add(fileId);
    /** File id to trash+replace on the next save (source, then intermediates). */
    let replaceFileId = initialReplaceFileId;
    /** Last successful upload in this drain — kept if a later coalesce save fails. */
    let lastUploaded: EnteFile | undefined;
    try {
        while (pendingByFileId.has(fileId)) {
            await yieldToCoalesce();
            const entry = pendingByFileId.get(fileId);
            if (!entry) {
                break;
            }
            const { croppedBytes, dimensions } = entry;
            try {
                const uploaded = await save(
                    croppedBytes,
                    dimensions,
                    replaceFileId,
                );
                lastUploaded = uploaded;
                const stillPending = pendingByFileId.get(fileId);
                if (
                    stillPending &&
                    (stillPending.croppedBytes !== croppedBytes ||
                        stillPending.dimensions !== dimensions)
                ) {
                    // Newer bytes won — next save replaces this upload, not the
                    // already-trashed original.
                    replaceFileId = uploaded.id;
                    continue;
                }
                const waiters = stillPending?.waiters ?? entry.waiters;
                pendingByFileId.delete(fileId);
                // Let a same-tick enqueue land before we treat this as final.
                await yieldToCoalesce();
                const revived = pendingByFileId.get(fileId);
                if (revived) {
                    revived.waiters = [...waiters, ...revived.waiters];
                    replaceFileId = uploaded.id;
                    continue;
                }
                try {
                    await options?.onCompleted?.(uploaded);
                } catch (completeError) {
                    const err = toError(completeError);
                    for (const waiter of waiters) {
                        waiter.reject(err);
                    }
                    return;
                }
                const revivedAfterComplete = pendingByFileId.get(fileId);
                if (revivedAfterComplete) {
                    revivedAfterComplete.waiters = [
                        ...waiters,
                        ...revivedAfterComplete.waiters,
                    ];
                    replaceFileId = uploaded.id;
                    continue;
                }
                for (const waiter of waiters) {
                    waiter.resolve(uploaded);
                }
            } catch (error) {
                const stillPending = pendingByFileId.get(fileId);
                const waiters = stillPending?.waiters ?? entry.waiters;
                pendingByFileId.delete(fileId);
                if (lastUploaded) {
                    // An earlier save already replaced the source. Keep that
                    // file rather than rejecting into a stuck outbox on a
                    // trashed id — unless newer bytes arrived meanwhile.
                    try {
                        await options?.onCompleted?.(lastUploaded);
                    } catch (completeError) {
                        const err = toError(completeError);
                        for (const waiter of waiters) {
                            waiter.reject(err);
                        }
                        return;
                    }
                    const revived = pendingByFileId.get(fileId);
                    if (revived) {
                        revived.waiters = [...waiters, ...revived.waiters];
                        replaceFileId = lastUploaded.id;
                        continue;
                    }
                    for (const waiter of waiters) {
                        waiter.resolve(lastUploaded);
                    }
                    return;
                }
                const err = toError(error);
                for (const waiter of waiters) {
                    waiter.reject(err);
                }
            }
        }
    } finally {
        activeFileIds.delete(fileId);
        if (pendingByFileId.has(fileId)) {
            // A new enqueue arrived while we were finishing — replace the last
            // published derived file, not the original source id.
            void drainDerivedReplaceQueue(
                fileId,
                save,
                options,
                lastUploaded?.id ?? initialReplaceFileId,
            );
        }
    }
};

/** @internal vitest only */
export const resetDerivedReplaceQueueForTests = (): void => {
    pendingByFileId.clear();
    activeFileIds.clear();
};
