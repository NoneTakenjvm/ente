import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { getEnteCore } from "@/core";
import { mapBatched } from "@/lib/batched";
import {
    getDerivedReplaceOutboxEntries,
    isDerivedReplaceOutboxHydrated,
    type DerivedReplaceOutboxEntry,
} from "@/lib/derived-replace-outbox";
import {
    getFavoriteOutboxEntries,
    isFavoriteOutboxHydrated,
    removeFavoriteOutboxEntries,
    type FavoriteOutboxEntry,
} from "@/lib/favorite-outbox";
import {
    getTagOutboxEntries,
    isTagOutboxHydrated,
} from "@/lib/tag-outbox";
import { writeAndVerifyTags } from "@/lib/tag-write-pipeline";
import {
    getVisibilityOutboxEntries,
    isVisibilityOutboxHydrated,
    removeVisibilityOutboxEntries,
    type VisibilityOutboxEntry,
} from "@/lib/visibility-outbox";

const drainIntervalMs = 60_000;

let intervalId: ReturnType<typeof setInterval> | undefined;
let draining = false;

export interface TagOutboxRunnerContext {
    getFiles: () => EnteFile[];
    getCollections: () => Collection[];
    patchFile: (file: EnteFile) => Promise<void>;
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

const drainTagEntries = async (
    context: TagOutboxRunnerContext,
): Promise<void> => {
    if (!isTagOutboxHydrated()) {
        return;
    }
    const entries = getTagOutboxEntries();
    if (!entries.length) {
        return;
    }

    const { getFiles, getCollections, patchFile } = context;
    const filesById = new Map(getFiles().map((file) => [file.id, file]));
    const collections = getCollections();
    const http = getEnteCore().getHttpClient();
    await mapBatched(
        entries,
        async (entry) => {
            const file = filesById.get(entry.fileId);
            if (!file) {
                return;
            }
            const collectionKey = collectionKeyFor(file, collections);
            if (!collectionKey) {
                return;
            }
            const result = await writeAndVerifyTags(
                http,
                file,
                collectionKey,
                entry.intendedTags,
            );
            if (result.status === "verified") {
                await patchFile(result.file);
            }
        },
        { concurrency: 2 },
    );
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
            try {
                await context.retryDerivedReplace?.(entry);
            } catch {
                // Keep entry for the next drain pass.
            }
        },
        { concurrency: 1 },
    );
};

/**
 * Process pending tag, favourite, visibility, and derived-replace outbox entries.
 */
export const drainTagOutbox = async (): Promise<void> => {
    if (draining || !runnerContext) {
        return;
    }
    draining = true;
    try {
        await drainTagEntries(runnerContext);
        await drainFavoriteEntries(runnerContext);
        await drainVisibilityEntries(runnerContext);
        await drainDerivedReplaceEntries(runnerContext);
    } finally {
        draining = false;
    }
};

/**
 * Start periodic outbox draining and run an immediate pass.
 */
export const startTagOutboxRunner = (
    context: TagOutboxRunnerContext,
): void => {
    stopTagOutboxRunner();
    runnerContext = context;
    void drainTagOutbox();
    intervalId = setInterval(() => {
        void drainTagOutbox();
    }, drainIntervalMs);
};

export const stopTagOutboxRunner = (): void => {
    if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
    }
    runnerContext = undefined;
    draining = false;
};
