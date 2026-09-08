import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
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
    getFavoriteOutboxEntries,
    isFavoriteOutboxHydrated,
    removeFavoriteOutboxEntries,
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
    removeVisibilityOutboxEntries,
    type VisibilityOutboxEntry,
} from "@/lib/visibility-outbox";

const drainIntervalMs = 60_000;
const flushDebounceMs = 400;
const failureToastCooldownMs = 5 * 60_000;

let intervalId: ReturnType<typeof setInterval> | undefined;
let flushDebounceId: ReturnType<typeof setTimeout> | undefined;
let drainChain: Promise<TagOutboxDrainStats> = Promise.resolve({
    verifiedIds: [],
    pendingIds: [],
    writeFailures: 0,
});
let lastFailureToastAt = 0;

export interface TagOutboxDrainStats {
    verifiedIds: number[];
    pendingIds: number[];
    /** Files whose PUT/verify failed this pass (not superseded intents). */
    writeFailures: number;
}

export interface TagOutboxRunnerContext {
    getFiles: () => EnteFile[];
    getCollections: () => Collection[];
    patchFile: (file: EnteFile) => Promise<void>;
    /** Preferred: one library update + one scheduled encrypt for many verifies. */
    patchFiles?: (files: EnteFile[]) => void | Promise<void>;
    /** Apply a pending favourite mutation (add/remove). */
    applyFavoriteMutation?: (entry: FavoriteOutboxEntry) => Promise<void>;
    /** Optional full favourites/library sync after favourite drains. */
    syncFavorites?: () => Promise<void>;
    /** Apply a pending visibility (archive) mutation. */
    applyVisibilityMutation?: (entry: VisibilityOutboxEntry) => Promise<void>;
    /** Retry a pending derived replace (crop/rotate/video-edit). */
    retryDerivedReplace?: (entry: DerivedReplaceOutboxEntry) => Promise<void>;
}

let runnerContext: TagOutboxRunnerContext | undefined;

const collectionKeyFor = (
    file: EnteFile,
    collections: Collection[],
): string | undefined => {
    const collection = collections.find((entry) => entry.id === file.collectionID);
    return collection?.key;
};

const favoriteEntryKey = (entry: FavoriteOutboxEntry): string =>
    entry.fileHashAndTypeKey ?? String(entry.fileId);

const notifyTagWriteFailures = (
    pendingCount: number,
    source: "user" | "periodic",
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
        pendingCount === 1 ?
            "Couldn't sync tags for 1 photo — will keep retrying" :
            `Couldn't sync tags for ${pendingCount} photos — will keep retrying`,
    );
};

/**
 * Batch-write pending tag outbox entries and ack those that land.
 */
const drainTagEntries = async (
    context: TagOutboxRunnerContext,
): Promise<TagOutboxDrainStats> => {
    if (!isTagOutboxHydrated()) {
        return { verifiedIds: [], pendingIds: [], writeFailures: 0 };
    }
    const entries = getTagOutboxEntries();
    if (!entries.length) {
        return { verifiedIds: [], pendingIds: [], writeFailures: 0 };
    }

    const { getFiles, getCollections, patchFile, patchFiles } = context;
    const filesById = new Map(getFiles().map((file) => [file.id, file]));
    const collections = getCollections();
    const http = getEnteCore().getHttpClient();

    const items: TagWriteItem[] = [];
    const skippedIds: number[] = [];
    for (const entry of entries) {
        const file = filesById.get(entry.fileId);
        if (!file) {
            skippedIds.push(entry.fileId);
            continue;
        }
        const collectionKey = collectionKeyFor(file, collections);
        if (!collectionKey) {
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
        if (patchFiles) {
            await patchFiles(filesToPatch);
        } else {
            for (const file of filesToPatch) {
                await patchFile(file);
            }
        }
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

const drainFavoriteEntries = async (
    context: TagOutboxRunnerContext,
): Promise<void> => {
    if (!isFavoriteOutboxHydrated() || !context.applyFavoriteMutation) {
        return;
    }
    const entries = getFavoriteOutboxEntries();
    if (!entries.length) {
        return;
    }

    let anySucceeded = false;
    await mapBatched(
        entries,
        async (entry) => {
            try {
                await context.applyFavoriteMutation?.(entry);
                await removeFavoriteOutboxEntries([favoriteEntryKey(entry)]);
                anySucceeded = true;
            } catch {
                // Keep entry for the next drain pass.
            }
        },
        { concurrency: 2 },
    );
    if (anySucceeded && context.syncFavorites) {
        try {
            await context.syncFavorites();
        } catch {
            // Favourites already applied; sync can retry later.
        }
    }
};

const drainVisibilityEntries = async (
    context: TagOutboxRunnerContext,
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
                await removeVisibilityOutboxEntries([entry.fileId]);
            } catch {
                // Keep entry for the next drain pass.
            }
        },
        { concurrency: 2 },
    );
};

const drainDerivedReplaceEntries = async (
    context: TagOutboxRunnerContext,
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
        return { verifiedIds: [], pendingIds: [], writeFailures: 0 };
    }

    let stats: TagOutboxDrainStats;
    try {
        stats = await drainTagEntries(runnerContext);
    } catch (error) {
        console.warn("Tag outbox drain failed", error);
        const pending = getTagOutboxEntries().length;
        if (notify && pending > 0) {
            notifyTagWriteFailures(pending, source);
        }
        return {
            verifiedIds: [],
            pendingIds: getTagOutboxEntries().map((entry) => entry.fileId),
            writeFailures: pending,
        };
    }

    await drainFavoriteEntries(runnerContext);
    await drainVisibilityEntries(runnerContext);
    await drainDerivedReplaceEntries(runnerContext);

    if (notify && stats.writeFailures > 0) {
        notifyTagWriteFailures(stats.writeFailures, source);
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
        .catch(() => ({
            verifiedIds: [] as number[],
            pendingIds: [] as number[],
            writeFailures: 0,
        }))
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
export const startTagOutboxRunner = (
    context: TagOutboxRunnerContext,
): void => {
    stopTagOutboxRunner();
    runnerContext = context;
    void runDrainPass("periodic");
    intervalId = setInterval(() => {
        void runDrainPass("periodic");
    }, drainIntervalMs);
};

export const stopTagOutboxRunner = (): void => {
    if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
    }
    if (flushDebounceId !== undefined) {
        clearTimeout(flushDebounceId);
        flushDebounceId = undefined;
    }
    runnerContext = undefined;
    drainChain = Promise.resolve({
        verifiedIds: [],
        pendingIds: [],
        writeFailures: 0,
    });
};
