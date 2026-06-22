import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { mapBatched } from "@/lib/batched";
import { removeTagOutboxEntries, upsertTagOutboxEntry } from "@/lib/tag-outbox";
import { writeAndVerifyTags } from "@/lib/tag-write-pipeline";
import {
    mergeTagNames,
    removeTagNames,
    replaceTagName,
    tagsForFile,
    type TagMutator,
} from "@/lib/tag-writes";
import type { HttpClient } from "@/core/api/http";

export interface BatchTagResult {
    succeeded: number;
    failed: number;
    errors: string[];
}

const collectionKeyFor = (
    file: EnteFile,
    collections: Collection[],
): string | undefined => {
    const collection = collections.find((entry) => entry.id === file.collectionID);
    return collection?.key;
};

const syncFileTags = async (
    http: HttpClient,
    file: EnteFile,
    collections: Collection[],
    intendedTags: string[],
): Promise<EnteFile | undefined> => {
    const collectionKey = collectionKeyFor(file, collections);
    if (!collectionKey) {
        return undefined;
    }
    await upsertTagOutboxEntry(file.id, intendedTags);
    const result = await writeAndVerifyTags(
        http,
        file,
        collectionKey,
        intendedTags,
    );
    if (result.status === "verified") {
        await removeTagOutboxEntries([file.id]);
        return result.file;
    }
    return undefined;
};

const runBatchTagUpdate = async (
    http: HttpClient,
    files: EnteFile[],
    collections: Collection[],
    mutator: TagMutator,
    onFileVerified?: (file: EnteFile) => Promise<void>,
    onProgress?: (completed: number, total: number) => void,
): Promise<BatchTagResult> => {
    const errors: string[] = [];
    let succeeded = 0;
    let failed = 0;

    await mapBatched(
        files,
        async (file) => {
            const intendedTags = tagsForFile(file, mutator);
            try {
                const verifiedFile = await syncFileTags(
                    http,
                    file,
                    collections,
                    intendedTags,
                );
                if (verifiedFile) {
                    succeeded += 1;
                    await onFileVerified?.(verifiedFile);
                } else {
                    failed += 1;
                    errors.push(`${file.id}: verification pending`);
                }
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
    onFileVerified?: (file: EnteFile) => Promise<void>,
    onProgress?: (completed: number, total: number) => void,
): Promise<BatchTagResult> => {
    const mutator: TagMutator = (tags) =>
        replaceTagName(tags, oldName, newName);
    return runBatchTagUpdate(
        http,
        files,
        collections,
        mutator,
        onFileVerified,
        onProgress,
    );
};

export const deleteTagOnFiles = async (
    http: HttpClient,
    files: EnteFile[],
    collections: Collection[],
    tagName: string,
    onFileVerified?: (file: EnteFile) => Promise<void>,
    onProgress?: (completed: number, total: number) => void,
): Promise<BatchTagResult> => {
    const mutator: TagMutator = (tags) => removeTagNames(tags, tagName);
    return runBatchTagUpdate(
        http,
        files,
        collections,
        mutator,
        onFileVerified,
        onProgress,
    );
};

export const mergeTagsOnFiles = async (
    http: HttpClient,
    files: EnteFile[],
    collections: Collection[],
    sourceNames: string[],
    targetName: string,
    onFileVerified?: (file: EnteFile) => Promise<void>,
    onProgress?: (completed: number, total: number) => void,
): Promise<BatchTagResult> => {
    const mutator: TagMutator = (tags) =>
        mergeTagNames(tags, sourceNames, targetName);
    return runBatchTagUpdate(
        http,
        files,
        collections,
        mutator,
        onFileVerified,
        onProgress,
    );
};
