import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { getEnteCore } from "@/core";
import { mapBatched } from "@/lib/batched";
import {
    getTagOutboxEntries,
    isTagOutboxHydrated,
    removeTagOutboxEntries,
} from "@/lib/tag-outbox";
import { writeAndVerifyTags } from "@/lib/tag-write-pipeline";

const drainIntervalMs = 60_000;

let intervalId: ReturnType<typeof setInterval> | undefined;
let draining = false;

export interface TagOutboxRunnerContext {
    getFiles: () => EnteFile[];
    getCollections: () => Collection[];
    patchFile: (file: EnteFile) => Promise<void>;
}

let runnerContext: TagOutboxRunnerContext | undefined;

const collectionKeyFor = (
    file: EnteFile,
    collections: Collection[],
): string | undefined => {
    const collection = collections.find((entry) => entry.id === file.collectionID);
    return collection?.key;
};

/**
 * Process all pending outbox entries: write, verify, and remove successes.
 */
export const drainTagOutbox = async (): Promise<void> => {
    if (draining || !runnerContext || !isTagOutboxHydrated()) {
        return;
    }
    draining = true;
    try {
        const entries = getTagOutboxEntries();
        if (!entries.length) {
            return;
        }

        const { getFiles, getCollections, patchFile } = runnerContext;
        const filesById = new Map(getFiles().map((file) => [file.id, file]));
        const collections = getCollections();
        const http = getEnteCore().getHttpClient();
        const verifiedIds: number[] = [];

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
                    verifiedIds.push(entry.fileId);
                    await patchFile(result.file);
                }
            },
            { concurrency: 2 },
        );

        if (verifiedIds.length > 0) {
            await removeTagOutboxEntries(verifiedIds);
        }
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
