import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { batch } from "ente-utils/array";
import { toast } from "sonner";
import { getEnteCore } from "@/core";
import { mapBatched } from "@/lib/batched";
import {
    getDerivedReplaceOutboxEntries,
    isDerivedReplaceOutboxHydrated,
    type DerivedReplaceOutboxEntry,
} from "@/lib/derived-replace-outbox";
import { isDerivedReplaceInFlight } from "@/lib/derived-replace-queue";
import {
    favoriteOutboxEntryKey,
    getFavoriteOutboxEntries,
    isFavoriteOutboxHydrated,
    removeFavoriteOutboxEntriesIfUnchanged,
    type FavoriteOutboxEntry,
} from "@/lib/favorite-outbox";
import {
    getTagOutboxEntries,
    getTagOutboxEntry,
    isTagOutboxHydrated,
    removeTagOutboxEntries,
} from "@/lib/tag-outbox";
import {
    writeAndVerifyTagsBatch,
    type TagWriteItem,
} from "@/lib/tag-write-pipeline";
import { extractTags } from "@/lib/tags";
import { tagsEqual } from "@/lib/tag-writes";
import {
    getVisibilityOutboxEntries,
    isVisibilityOutboxHydrated,
    removeVisibilityOutboxEntryIfUnchanged,
    type VisibilityOutboxEntry,
} from "@/lib/visibility-outbox";
import { registerReset } from "@/lib/session-lifecycle";

const drainIntervalMs = 60_000;
const flushDebounceMs = 400;
const failureToastCooldownMs = 5 * 60_000;
/** Favourites API accepts large payloads; chunk so partial progress can ack. */
const favoriteDrainChunkSize = 100;

let intervalId: ReturnType<typeof setInterval> | undefined;
let flushDebounceId: ReturnType<typeof setTimeout> | undefined;
let drainChain: Promise<TagOutboxDrainStats> = Promise.resolve(
    emptyDrainStats(),
);
let lastFailureToastAt = 0;

export interface TagOutboxDrainStats {
    verifiedIds: number[];
    pendingIds: number[];
    /** Files whose PUT/verify failed this pass (not superseded intents). */
    writeFailures: number;
}

function emptyDrainStats(): TagOutboxDrainStats {
    return { verifiedIds: [], pendingIds: [], writeFailures: 0 };
}

export interface FavoriteMutationsResult {
    /** Outbox keys that were applied on remote (or safely discarded, e.g. trashed). */
    ackedKeys: string[];
}

export interface OutboxRunnerContext {
    /** O(1) library lookup (the store's id index), not a scan of all files. */
    getFileById: (fileId: number) => EnteFile | undefined;
    getCollections: () => Collection[];
    /** One library update + one scheduled encrypt for many verified files. */
    patchFiles: (files: EnteFile[]) => void | Promise<void>;
    /** Apply many pending favourite mutations in one remote batch. */
    applyFavoriteMutations: (
        entries: FavoriteOutboxEntry[],
    ) => Promise<FavoriteMutationsResult>;
    /** Optional full favourites/library sync after favourite drains. */
    syncFavorites?: () => Promise<void>;
    /** Apply a pending visibility (archive) mutation. */
    applyVisibilityMutation?: (entry: VisibilityOutboxEntry) => Promise<void>;
    /** Retry a pending derived replace (crop/rotate/video-edit). */
    retryDerivedReplace?: (entry: DerivedReplaceOutboxEntry) => Promise<void>;
}

let runnerContext: OutboxRunnerContext | undefined;

const describeTagFailures = (count: number): string =>
    count === 1 ? "tags for 1 photo" : `tags for ${count} photos`;

const describeFavoriteFailures = (count: number): string =>
    count === 1 ? "1 favourite" : `${count} favourites`;

const notifyFailures = (
    pendingCount: number,
    source: "user" | "periodic",
    describe: (count: number) => string,
): void => {
    if (pendingCount <= 0) {
        return;
    }
    const now = Date.now();
    if (
        source === "periodic" &&
        now - lastFailureToastAt < failureToastCooldownMs
    ) {
        return;
    }
    lastFailureToastAt = now;
    toast.error(
        `Couldn't sync ${describe(pendingCount)} — will keep retrying`,
    );
};

/**
 * Batch-write pending tag outbox entries and ack those that land.
 */
const drainTagEntries = async (
    context: OutboxRunnerContext,
): Promise<TagOutboxDrainStats> => {
    if (!isTagOutboxHydrated()) {
        return emptyDrainStats();
    }
    const entries = getTagOutboxEntries();
    if (!entries.length) {
        return emptyDrainStats();
    }

    const { getFileById, getCollections, patchFiles } = context;
    const collectionKeyById = new Map(
        getCollections().map((collection) => [collection.id, collection.key]),
    );
    const http = getEnteCore().getHttpClient();

    const items: TagWriteItem[] = [];
    const skippedIds: number[] = [];
    for (const entry of entries) {
        const file = getFileById(entry.fileId);
        const collectionKey = file && collectionKeyById.get(file.collectionID);
        if (!file || !collectionKey) {
            skippedIds.push(entry.fileId);
            continue;
        }
        items.push({
            file,
            collectionKey,
            intendedTags: entry.intendedTags,
        });
    }

    if (!items.length) {
        return { verifiedIds: [], pendingIds: skippedIds, writeFailures: 0 };
    }

    const result = await writeAndVerifyTagsBatch(http, items);
    const verifiedIds: number[] = [];
    const pendingIds = [...skippedIds];
    let superseded = 0;
    const filesToPatch: EnteFile[] = [];

    for (const file of result.verified) {
        const writtenTags = extractTags(file);
        const current = getTagOutboxEntry(file.id);
        if (!current) {
            // Already removed (e.g. reconciled) — still patch local metadata.
        } else if (tagsEqual(current.intendedTags, writtenTags)) {
            verifiedIds.push(file.id);
        } else {
            // Newer intent arrived while the write was in flight — keep outbox.
            pendingIds.push(file.id);
            superseded += 1;
        }
        filesToPatch.push(file);
    }

    if (filesToPatch.length) {
        await patchFiles(filesToPatch);
    }

    for (const file of result.pending) {
        pendingIds.push(file.id);
    }

    if (verifiedIds.length) {
        await removeTagOutboxEntries(verifiedIds);
    }

    if (superseded > 0) {
        requestTagOutboxFlush();
    }

    return {
        verifiedIds,
        pendingIds,
        writeFailures: result.pending.length,
    };
};

/**
 * Drain the favourite outbox in remote batches (add chunks, then remove
 * chunks). A chunk that throws is retried one entry at a time so a single bad
 * entry cannot strand the rest. One-at-a-time drain was too slow for bulk
 * favouriting and left hundreds of intents stranded on tab close.
 */
const drainFavoriteEntries = async (
    context: OutboxRunnerContext,
    source: "user" | "periodic",
    notify: boolean,
): Promise<void> => {
    if (!isFavoriteOutboxHydrated()) {
        return;
    }
    const entries = getFavoriteOutboxEntries();
    if (!entries.length) {
        return;
    }

    let anySucceeded = false;
    let failures = 0;

    /** Apply `chunk` remotely and ack the entries that landed. Returns the ack count. */
    const applyChunk = async (chunk: FavoriteOutboxEntry[]): Promise<number> => {
        const { ackedKeys } = await context.applyFavoriteMutations(chunk);
        const acked = new Set(ackedKeys);
        // Entries re-queued while their request was in flight stay pending.
        const ackedChunk = chunk.filter((entry) =>
            acked.has(favoriteOutboxEntryKey(entry)));
        await removeFavoriteOutboxEntriesIfUnchanged(ackedChunk);
        return ackedChunk.length;
    };

    const processChunk = async (chunk: FavoriteOutboxEntry[]): Promise<void> => {
        try {
            const ackedCount = await applyChunk(chunk);
            anySucceeded ||= ackedCount > 0;
            failures += chunk.length - ackedCount;
            return;
        } catch {
            // Fall through to per-entry retries for this chunk.
        }
        await mapBatched(
            chunk,
            async (entry) => {
                try {
                    const ackedCount = await applyChunk([entry]);
                    anySucceeded ||= ackedCount > 0;
                    failures += 1 - ackedCount;
                } catch {
                    failures += 1;
                }
            },
            { concurrency: 2 },
        );
    };

    for (const group of [
        entries.filter((entry) => entry.isFavorite),
        entries.filter((entry) => !entry.isFavorite),
    ]) {
        for (const chunk of batch(group, favoriteDrainChunkSize)) {
            await processChunk(chunk);
        }
    }

    if (anySucceeded && context.syncFavorites) {
        try {
            await context.syncFavorites();
        } catch {
            // Favourites already applied; sync can retry later.
        }
    }

    const stillPending = getFavoriteOutboxEntries().length;
    if (notify && failures > 0 && stillPending > 0) {
        notifyFailures(stillPending, source, describeFavoriteFailures);
    }
};

const drainVisibilityEntries = async (
    context: OutboxRunnerContext,
): Promise<void> => {
    if (!isVisibilityOutboxHydrated() || !context.applyVisibilityMutation) {
        return;
    }
    const entries = getVisibilityOutboxEntries();
    if (!entries.length) {
        return;
    }

    await mapBatched(
        entries,
        async (entry) => {
            try {
                await context.applyVisibilityMutation?.(entry);
                await removeVisibilityOutboxEntryIfUnchanged(entry);
            } catch {
                // Keep entry for the next drain pass.
            }
        },
        { concurrency: 2 },
    );
};

const drainDerivedReplaceEntries = async (
    context: OutboxRunnerContext,
): Promise<void> => {
    if (!isDerivedReplaceOutboxHydrated() || !context.retryDerivedReplace) {
        return;
    }
    const entries = getDerivedReplaceOutboxEntries();
    if (!entries.length) {
        return;
    }

    await mapBatched(
        entries,
        async (entry) => {
            // Live crop/compress/video-edit owns this id until finalize clears
            // the outbox — a concurrent retry would upload a duplicate.
            if (isDerivedReplaceInFlight(entry.fileId)) {
                return;
            }
            try {
                await context.retryDerivedReplace?.(entry);
            } catch {
                // Keep entry for the next drain pass.
            }
        },
        { concurrency: 1 },
    );
};

const executeDrainPass = async (
    source: "user" | "periodic",
    notify: boolean,
): Promise<TagOutboxDrainStats> => {
    if (!runnerContext) {
        return emptyDrainStats();
    }

    let stats: TagOutboxDrainStats;
    try {
        stats = await drainTagEntries(runnerContext);
    } catch (error) {
        console.warn("Tag outbox drain failed", error);
        const pending = getTagOutboxEntries().length;
        if (notify && pending > 0) {
            notifyFailures(pending, source, describeTagFailures);
        }
        return {
            verifiedIds: [],
            pendingIds: getTagOutboxEntries().map((entry) => entry.fileId),
            writeFailures: pending,
        };
    }

    // [Note: drain ordering]
    // Favourite and visibility drains touch separate outboxes and remote
    // endpoints, so they run together. A derived replace swaps a file for a new
    // id and remaps both outboxes, so it must wait until they have settled.
    await Promise.all([
        drainFavoriteEntries(runnerContext, source, notify),
        drainVisibilityEntries(runnerContext),
    ]);
    await drainDerivedReplaceEntries(runnerContext);

    if (notify && stats.writeFailures > 0) {
        notifyFailures(stats.writeFailures, source, describeTagFailures);
    }

    return {
        verifiedIds: stats.verifiedIds,
        pendingIds: getTagOutboxEntries().map((entry) => entry.fileId),
        writeFailures: stats.writeFailures,
    };
};

/**
 * Serialize drains so concurrent flush/interval calls never double-write.
 */
const runDrainPass = (
    source: "user" | "periodic",
    notify = true,
): Promise<TagOutboxDrainStats> => {
    drainChain = drainChain
        .catch(emptyDrainStats)
        .then(() => executeDrainPass(source, notify));
    return drainChain;
};

/**
 * Process pending tag, favourite, visibility, and derived-replace outbox entries.
 */
export const drainTagOutbox = async (): Promise<void> => {
    await runDrainPass("periodic");
};

/**
 * Cancel any debounced flush and drain the outbox immediately.
 *
 * @param options.notify when false, skip failure toasts (caller reports instead).
 */
export const flushTagOutboxNow = async (options?: {
    notify?: boolean;
}): Promise<TagOutboxDrainStats> => {
    if (flushDebounceId !== undefined) {
        clearTimeout(flushDebounceId);
        flushDebounceId = undefined;
    }
    return runDrainPass("user", options?.notify !== false);
};

/**
 * Schedule a debounced outbox flush so rapid one-by-one edits coalesce into
 * one batch PUT.
 */
export const requestTagOutboxFlush = (): void => {
    if (flushDebounceId !== undefined) {
        clearTimeout(flushDebounceId);
    }
    flushDebounceId = setTimeout(() => {
        flushDebounceId = undefined;
        void runDrainPass("user");
    }, flushDebounceMs);
};

/**
 * Start periodic outbox draining and run an immediate pass.
 */
export const startOutboxRunner = (
    context: OutboxRunnerContext,
): void => {
    stopOutboxRunner();
    runnerContext = context;
    void runDrainPass("periodic");
    intervalId = setInterval(() => {
        void runDrainPass("periodic");
    }, drainIntervalMs);
};

export const stopOutboxRunner = (): void => {
    if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
    }
    if (flushDebounceId !== undefined) {
        clearTimeout(flushDebounceId);
        flushDebounceId = undefined;
    }
    runnerContext = undefined;
    drainChain = Promise.resolve(emptyDrainStats());
};

registerReset(stopOutboxRunner);
