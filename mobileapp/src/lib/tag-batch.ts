import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { getTagOutboxEntries, upsertTagOutboxEntry } from "@/lib/tag-outbox";
import { flushTagOutboxNow } from "@/lib/tag-outbox-runner";
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

/**
 * Queue each file's intended tags and flush the shared outbox (batched PUTs).
 *
 * Library patching happens inside the outbox runner on verified writes.
 */
const runBatchTagUpdate = async (
    _http: HttpClient,
    files: EnteFile[],
    _collections: Collection[],
    mutator: TagMutator,
    _onFileVerified?: (file: EnteFile) => Promise<void>,
    onProgress?: (completed: number, total: number) => void,
): Promise<BatchTagResult> => {
    const targetIds = new Set(files.map((file) => file.id));
    const errors: string[] = [];

    for (const file of files) {
        await upsertTagOutboxEntry(file.id, tagsForFile(file, mutator));
    }

    onProgress?.(0, files.length);
    await flushTagOutboxNow({ notify: false });

    const pendingIds = new Set(
        getTagOutboxEntries()
            .map((entry) => entry.fileId)
            .filter((fileId) => targetIds.has(fileId)),
    );
    const failed = pendingIds.size;
    const succeeded = files.length - failed;
    for (const fileId of pendingIds) {
        errors.push(`${fileId}: sync pending`);
    }
    onProgress?.(succeeded, files.length);

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

/**
 * Queue tag mutators on each file and flush the shared outbox (batched PUTs).
 */
export const applyTagMutatorOnFiles = async (
    http: HttpClient,
    files: EnteFile[],
    collections: Collection[],
    mutator: TagMutator,
    onFileVerified?: (file: EnteFile) => Promise<void>,
    onProgress?: (completed: number, total: number) => void,
): Promise<BatchTagResult> => {
    return runBatchTagUpdate(
        http,
        files,
        collections,
        mutator,
        onFileVerified,
        onProgress,
    );
};
