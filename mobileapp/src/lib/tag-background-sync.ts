import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import type { HttpClient } from "@/core/api/http";
import { enqueueTagSave } from "@/lib/tag-save-queue";
import { writeAndVerifyTags } from "@/lib/tag-write-pipeline";

const collectionKeyFor = (
    file: EnteFile,
    collections: Collection[],
): string => {
    const collection = collections.find((entry) => entry.id === file.collectionID);
    if (!collection) {
        throw new Error(`Collection ${file.collectionID} not found`);
    }
    return collection.key;
};

export interface TagBackgroundSyncContext {
    getHttp: () => HttpClient;
    getFile: (fileId: number) => EnteFile | undefined;
    getCollections: () => Collection[];
    patchFile: (file: EnteFile) => Promise<void>;
}

/**
 * Coalesce rapid tag edits and sync to remote in the background.
 */
export const scheduleTagBackgroundSync = (
    fileId: number,
    intendedTags: string[],
    context: TagBackgroundSyncContext,
): void => {
    void enqueueTagSave(
        fileId,
        intendedTags,
        async (tags) => {
            const file = context.getFile(fileId);
            if (!file) {
                throw new Error(`File ${fileId} not found`);
            }
            const result = await writeAndVerifyTags(
                context.getHttp(),
                file,
                collectionKeyFor(file, context.getCollections()),
                tags,
            );
            if (result.status === "verified") {
                await context.patchFile(result.file);
            }
            return result.file;
        },
    ).catch(() => {
        // Outbox retains the entry for periodic retry.
    });
};
