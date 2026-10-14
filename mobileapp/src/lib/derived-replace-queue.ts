import type { EnteFile } from "ente-media/file";

interface DerivedReplaceWaiter {
    resolve: (file: EnteFile) => void;
    reject: (error: Error) => void;
}

interface PendingDerivedReplace {
    croppedBytes: Uint8Array;
    dimensions: { width: number; height: number };
    /** Options of the latest enqueue, which owns the final completion. */
    options?: EnqueueDerivedReplaceOptions;
    waiters: DerivedReplaceWaiter[];
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
    /**
     * Runs when a save fails after an earlier save in the same drain already
     * replaced the source with {@link lastUploaded}. The source id is gone, so
     * the failed bytes must be re-keyed to it before their waiters reject.
     */
    onFailed?: (error: Error, lastUploaded: EnteFile) => Promise<void>;
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
            pending = { croppedBytes, dimensions, options, waiters: [] };
            pendingByFileId.set(fileId, pending);
        } else {
            pending.croppedBytes = croppedBytes;
            pending.dimensions = dimensions;
            pending.options = options;
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
    /** Waiters whose bytes were part of a successful save in this drain. */
    const savedWaiters = new Set<DerivedReplaceWaiter>();
    try {
        while (pendingByFileId.has(fileId)) {
            await yieldToCoalesce();
            const entry = pendingByFileId.get(fileId);
            if (!entry) {
                break;
            }
            const { croppedBytes, dimensions } = entry;
            const waitersAtSaveStart = [...entry.waiters];
            try {
                const uploaded = await save(
                    croppedBytes,
                    dimensions,
                    replaceFileId,
                );
                lastUploaded = uploaded;
                for (const waiter of waitersAtSaveStart) {
                    savedWaiters.add(waiter);
                }
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
                const completionOptions =
                    stillPending?.options ?? entry.options ?? options;
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
                    await completionOptions?.onCompleted?.(uploaded);
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
                if (
                    stillPending &&
                    (stillPending.croppedBytes !== croppedBytes ||
                        stillPending.dimensions !== dimensions)
                ) {
                    // Newer bytes arrived during the failed save and supersede it.
                    continue;
                }
                const waiters = stillPending?.waiters ?? entry.waiters;
                const failureOptions =
                    stillPending?.options ?? entry.options ?? options;
                pendingByFileId.delete(fileId);
                const err = toError(error);
                if (lastUploaded) {
                    // An earlier save already replaced the source, so the failed
                    // bytes need re-keying to that upload before they can retry.
                    try {
                        await failureOptions?.onFailed?.(err, lastUploaded);
                    } catch {
                        // Entry stays keyed to the replaced id; the outbox drain
                        // drops it once that file is gone.
                    }
                }
                for (const waiter of waiters) {
                    if (lastUploaded && savedWaiters.has(waiter)) {
                        waiter.resolve(lastUploaded);
                    } else {
                        waiter.reject(err);
                    }
                }
                return;
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
