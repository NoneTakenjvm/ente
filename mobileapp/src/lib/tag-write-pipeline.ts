import type { EnteFile } from "ente-media/file";
import { isHTTPErrorWithStatus } from "ente-base/http";
import {
    isTransientError,
    retryWithBackoff,
    type HttpClient,
} from "@/core/api/http";
import { mergePublicMetadata, putFilesPublicMetadata } from "@/core/metadata";
import { batched } from "@/lib/batched";
import { buildOrganizerUpdate } from "@/lib/tag-writes";

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
const tagMetadataBatchSize = 100;

/**
 * Outer layer: retry 429, 5xx and network failures. A 409 is not retried here;
 * it is handled by the batch-to-per-file fallback and, per file, by the
 * refetch-and-merge retry inside {@link mergePublicMetadata}.
 */
const transportRetry = {
    attempts: 3,
    isRetryable: isTransientError,
    baseDelayMs: 500,
    maxDelayMs: 30_000,
};

/**
 * Write organizer tags for many files using Ente's batch metadata API.
 *
 * One PUT per chunk. If the chunk hits a version conflict it falls back to
 * per-file writes that refetch and re-merge on conflict. A PUT the server
 * accepts is authoritative: the written files are returned as `verified`
 * without a refetch. Files whose write failed come back as `pending`.
 */
export const writeAndVerifyTagsBatch = async (
    http: HttpClient,
    items: TagWriteItem[],
    options?: {
        onProgress?: (completed: number, total: number) => void;
    },
): Promise<TagBatchWriteResult> => {
    const verified: EnteFile[] = [];
    const pending: EnteFile[] = [];
    let completed = 0;
    const report = (delta: number): void => {
        completed += delta;
        options?.onProgress?.(completed, items.length);
    };

    await batched(
        items,
        async (chunk) => {
            try {
                verified.push(
                    ...(await retryWithBackoff(
                        () =>
                            putFilesPublicMetadata(
                                http,
                                chunk.map(({ file, intendedTags }) => ({
                                    file,
                                    updates: buildOrganizerUpdate(intendedTags),
                                })),
                            ),
                        transportRetry,
                    )),
                );
                report(chunk.length);
            } catch (error) {
                if (!isHTTPErrorWithStatus(error, 409)) {
                    pending.push(...chunk.map(({ file }) => file));
                    report(chunk.length);
                    return;
                }
                for (const { file, collectionKey, intendedTags } of chunk) {
                    const updates = buildOrganizerUpdate(intendedTags);
                    try {
                        await retryWithBackoff(
                            () =>
                                mergePublicMetadata(
                                    http,
                                    file,
                                    collectionKey,
                                    updates,
                                ),
                            transportRetry,
                        );
                        verified.push(file);
                    } catch {
                        pending.push(file);
                    }
                    report(1);
                }
            }
        },
        tagMetadataBatchSize,
    );

    return { verified, pending };
};
