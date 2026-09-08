import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import {
    enqueueTagOutboxEntries,
    getTagOutboxEntries,
    upsertTagOutboxEntries,
} from "@/lib/tag-outbox";
import {
    flushTagOutboxNow,
    requestTagOutboxFlush,
} from "@/lib/tag-outbox-runner";
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

const intendedTagEntries = (
    files: EnteFile[],
    mutator: TagMutator,
): Array<{ fileId: number; intendedTags: string[] }> =>
    files.map((file) => ({
        fileId: file.id,
        intendedTags: tagsForFile(file, mutator),
    }));

/**
 * Queue each file's intended tags and await a full outbox drain (batched PUTs).
 *
 * Used by Manage rename/delete/merge where the UI waits on completion.
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

    await upsertTagOutboxEntries(intendedTagEntries(files, mutator));

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
 * Queue tag mutators and schedule a debounced outbox flush (does not wait).
 *
 * Selection / bulk UI paths use this so the click returns after local enqueue.
 * Failures surface later via the outbox runner toasts.
 */
export const applyTagMutatorOnFiles = async (
    _http: HttpClient,
    files: EnteFile[],
    _collections: Collection[],
    mutator: TagMutator,
    _onFileVerified?: (file: EnteFile) => Promise<void>,
    onProgress?: (completed: number, total: number) => void,
): Promise<BatchTagResult> => {
    if (!files.length) {
        return { succeeded: 0, failed: 0, errors: [] };
    }
    enqueueTagOutboxEntries(intendedTagEntries(files, mutator));
    requestTagOutboxFlush();
    onProgress?.(files.length, files.length);
    return { succeeded: files.length, failed: 0, errors: [] };
};
