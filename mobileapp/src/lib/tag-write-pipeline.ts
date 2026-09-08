import type { EnteFile } from "ente-media/file";
import { refetchFile } from "@/core/api/files";
import type { HttpClient } from "@/core/api/http";
import {
    MetadataUpdateError,
    putFilesTags,
    updateFileTags,
} from "@/core/metadata";
import { batched } from "@/lib/batched";
import { extractTags } from "@/lib/tags";
import { tagsEqual } from "@/lib/tag-writes";

export type TagWriteResult =
    { status: "verified"; file: EnteFile } |
    { status: "pending"; file: EnteFile };

export interface TagWriteItem {
    file: EnteFile;
    collectionKey: string;
    intendedTags: string[];
}

export interface TagBatchWriteResult {
    verified: EnteFile[];
    pending: EnteFile[];
}

/** Chunk size for tag metadata PUTs (Ente max is 1000; smaller limits conflict blast radius). */
export const tagMetadataBatchSize = 100;

const maxTransportAttempts = 3;

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

const retryDelayMs = (attempt: number, error: unknown): number => {
    if (error instanceof MetadataUpdateError && error.retryAfterMs) {
        return error.retryAfterMs;
    }
    return Math.min(30_000, 500 * 2 ** (attempt - 1));
};

const isRetryableTransportError = (error: unknown): boolean => {
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

const isBatchConflict = (error: unknown): boolean =>
    error instanceof MetadataUpdateError && error.status === 409;

const putTagsWithTransportRetry = async (
    http: HttpClient,
    file: EnteFile,
    collectionKey: string,
    intendedTags: string[],
): Promise<void> => {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxTransportAttempts; attempt++) {
        try {
            await updateFileTags(
                http,
                file,
                collectionKey,
                () => intendedTags,
            );
            return;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (
                !isRetryableTransportError(error) ||
                attempt >= maxTransportAttempts
            ) {
                throw lastError;
            }
            await sleep(retryDelayMs(attempt, error));
        }
    }
    throw lastError ?? new Error(`Tag PUT failed for file ${file.id}`);
};

const attemptWriteAndVerify = async (
    http: HttpClient,
    file: EnteFile,
    collectionKey: string,
    intendedTags: string[],
): Promise<EnteFile | undefined> => {
    await putTagsWithTransportRetry(http, file, collectionKey, intendedTags);
    const fresh = await refetchFile(http, file, collectionKey);
    const freshTags = extractTags(fresh);
    if (tagsEqual(freshTags, intendedTags)) {
        return fresh;
    }
    return undefined;
};

/**
 * PUT organizer tags for one file, verify on server, and retry once on mismatch.
 */
export const writeAndVerifyTags = async (
    http: HttpClient,
    file: EnteFile,
    collectionKey: string,
    intendedTags: string[],
): Promise<TagWriteResult> => {
    try {
        let verified = await attemptWriteAndVerify(
            http,
            file,
            collectionKey,
            intendedTags,
        );
        if (!verified) {
            verified = await attemptWriteAndVerify(
                http,
                file,
                collectionKey,
                intendedTags,
            );
        }
        if (verified) {
            return { status: "verified", file: verified };
        }
        const latest = await refetchFile(http, file, collectionKey);
        return { status: "pending", file: latest };
    } catch {
        return { status: "pending", file };
    }
};

const writeBatchChunkWithRetry = async (
    http: HttpClient,
    chunk: TagWriteItem[],
): Promise<EnteFile[]> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxTransportAttempts; attempt++) {
        try {
            return await putFilesTags(
                http,
                chunk.map((item) => ({
                    file: item.file,
                    intendedTags: item.intendedTags,
                })),
            );
        } catch (error) {
            lastError = error;
            if (isBatchConflict(error)) {
                throw error;
            }
            if (
                !isRetryableTransportError(error) ||
                attempt >= maxTransportAttempts
            ) {
                throw error;
            }
            await sleep(retryDelayMs(attempt, error));
        }
    }
    throw lastError;
};

const fallBackToPerFileWrites = async (
    http: HttpClient,
    chunk: TagWriteItem[],
    onProgress?: (completedDelta: number) => void,
): Promise<TagBatchWriteResult> => {
    const verified: EnteFile[] = [];
    const pending: EnteFile[] = [];
    for (const item of chunk) {
        const result = await writeAndVerifyTags(
            http,
            item.file,
            item.collectionKey,
            item.intendedTags,
        );
        if (result.status === "verified") {
            verified.push(result.file);
        } else {
            pending.push(result.file);
        }
        onProgress?.(1);
    }
    return { verified, pending };
};

/**
 * Write organizer tags for many files using Ente's batch metadata API.
 *
 * One PUT per chunk (≤1000). On version conflict the chunk falls back to
 * per-file writes with verify. Successful batch PUTs trust the response and
 * apply local metadata (version + 1) without an N-way refetch.
 */
export const writeAndVerifyTagsBatch = async (
    http: HttpClient,
    items: TagWriteItem[],
    options?: {
        onProgress?: (completed: number, total: number) => void;
    },
): Promise<TagBatchWriteResult> => {
    if (!items.length) {
        return { verified: [], pending: [] };
    }

    const verified: EnteFile[] = [];
    const pending: EnteFile[] = [];
    let completed = 0;
    const total = items.length;
    const report = (delta: number): void => {
        completed += delta;
        options?.onProgress?.(completed, total);
    };

    await batched(
        items,
        async (chunk) => {
            try {
                const updated = await writeBatchChunkWithRetry(http, chunk);
                for (let i = 0; i < chunk.length; i++) {
                    const item = chunk[i];
                    const file = updated[i];
                    if (
                        item &&
                        file &&
                        tagsEqual(extractTags(file), item.intendedTags)
                    ) {
                        verified.push(file);
                    } else if (file) {
                        pending.push(file);
                    } else if (item) {
                        pending.push(item.file);
                    }
                }
                report(chunk.length);
            } catch (error) {
                if (isBatchConflict(error)) {
                    const fallback = await fallBackToPerFileWrites(
                        http,
                        chunk,
                        report,
                    );
                    verified.push(...fallback.verified);
                    pending.push(...fallback.pending);
                    return;
                }
                pending.push(...chunk.map((item) => item.file));
                report(chunk.length);
            }
        },
        tagMetadataBatchSize,
    );

    return { verified, pending };
};
