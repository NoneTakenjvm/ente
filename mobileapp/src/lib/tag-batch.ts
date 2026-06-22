import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { updateFileTags } from "@/core/metadata";
import { mapBatched } from "@/lib/batched";
import {
    mergeTagNames,
    removeTagNames,
    replaceTagName,
    type TagMutator,
} from "@/lib/tag-writes";
import type { HttpClient } from "@/core/api/http";
import { MetadataUpdateError } from "@/core/metadata";

export interface BatchTagResult {
    succeeded: number;
    failed: number;
    errors: string[];
}

const maxTagSaveAttempts = 10;

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

const retryDelayMs = (attempt: number, error: unknown): number => {
    if (error instanceof MetadataUpdateError && error.retryAfterMs) {
        return error.retryAfterMs;
    }
    return Math.min(30_000, 500 * 2 ** (attempt - 1));
};

const isRetryableTagSaveError = (error: unknown): boolean => {
    if (error instanceof MetadataUpdateError) {
        return (
            error.status === 409 ||
            error.status === 429 ||
            error.status >= 500
        );
    }
    if (error instanceof TypeError) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return /failed to fetch|network|load failed/i.test(message);
};

const collectionKeyFor = (
    file: EnteFile,
    collections: Collection[],
): string => {
    const collection = collections.find((c) => c.id === file.collectionID);
    if (!collection) {
        throw new Error(`Collection ${file.collectionID} not found`);
    }
    return collection.key;
};

/**
 * Update tags on one file with conflict refetch and transient-error retries.
 */
export const writeFileTags = async (
    http: HttpClient,
    file: EnteFile,
    collections: Collection[],
    mutator: TagMutator,
): Promise<EnteFile> => {
    const collectionKey = collectionKeyFor(file, collections);
    return updateFileTags(http, file, collectionKey, mutator);
};

export const writeFileTagsWithRetry = async (
    http: HttpClient,
    file: EnteFile,
    collections: Collection[],
    mutator: TagMutator,
): Promise<EnteFile> => {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxTagSaveAttempts; attempt++) {
        try {
            return await writeFileTags(http, file, collections, mutator);
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (
                !isRetryableTagSaveError(error) ||
                attempt >= maxTagSaveAttempts
            ) {
                throw lastError;
            }
            await sleep(retryDelayMs(attempt, error));
        }
    }
    throw lastError ?? new Error("Tag save failed");
};

const runBatchTagUpdate = async (
    http: HttpClient,
    files: EnteFile[],
    collections: Collection[],
    mutator: TagMutator,
    onProgress?: (completed: number, total: number) => void,
): Promise<BatchTagResult> => {
    const errors: string[] = [];
    let succeeded = 0;
    let failed = 0;

    await mapBatched(
        files,
        async (file) => {
            try {
                await writeFileTagsWithRetry(http, file, collections, mutator);
                succeeded += 1;
            } catch (error) {
                failed += 1;
                errors.push(
                    error instanceof Error ?
                        `${file.id}: ${error.message}` :
                        `${file.id}: update failed`,
                );
            }
        },
        { concurrency: 2, onProgress },
    );

    return { succeeded, failed, errors };
};

export const renameTagOnFiles = async (
    http: HttpClient,
    files: EnteFile[],
    collections: Collection[],
    oldName: string,
    newName: string,
    onProgress?: (completed: number, total: number) => void,
): Promise<BatchTagResult> => {
    const mutator: TagMutator = (tags) =>
        replaceTagName(tags, oldName, newName);
    return runBatchTagUpdate(http, files, collections, mutator, onProgress);
};

export const deleteTagOnFiles = async (
    http: HttpClient,
    files: EnteFile[],
    collections: Collection[],
    tagName: string,
    onProgress?: (completed: number, total: number) => void,
): Promise<BatchTagResult> => {
    const mutator: TagMutator = (tags) => removeTagNames(tags, tagName);
    return runBatchTagUpdate(http, files, collections, mutator, onProgress);
};

export const mergeTagsOnFiles = async (
    http: HttpClient,
    files: EnteFile[],
    collections: Collection[],
    sourceNames: string[],
    targetName: string,
    onProgress?: (completed: number, total: number) => void,
): Promise<BatchTagResult> => {
    const mutator: TagMutator = (tags) =>
        mergeTagNames(tags, sourceNames, targetName);
    return runBatchTagUpdate(http, files, collections, mutator, onProgress);
};
