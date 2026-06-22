import type { EnteFile } from "ente-media/file";
import { refetchFile } from "@/core/api/files";
import type { HttpClient } from "@/core/api/http";
import { MetadataUpdateError, updateFileTags } from "@/core/metadata";
import { extractTags } from "@/lib/tags";
import { tagsEqual } from "@/lib/tag-writes";

export type TagWriteResult =
    { status: "verified"; file: EnteFile } |
    { status: "pending"; file: EnteFile };

const tagWriteConcurrency = 2;
const maxTransportAttempts = 3;

let activeWrites = 0;
const writeWaiters: Array<() => void> = [];

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

const acquireWriteSlot = async (): Promise<void> => {
    if (activeWrites < tagWriteConcurrency) {
        activeWrites += 1;
        return;
    }
    await new Promise<void>((resolve) => {
        writeWaiters.push(resolve);
    });
    activeWrites += 1;
};

const releaseWriteSlot = (): void => {
    activeWrites -= 1;
    const next = writeWaiters.shift();
    if (next) {
        next();
    }
};

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
    if (tagsEqual(extractTags(fresh), intendedTags)) {
        return fresh;
    }
    return undefined;
};

/**
 * PUT organizer tags, verify on server, and retry once on mismatch.
 */
export const writeAndVerifyTags = async (
    http: HttpClient,
    file: EnteFile,
    collectionKey: string,
    intendedTags: string[],
): Promise<TagWriteResult> => {
    await acquireWriteSlot();
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
    } finally {
        releaseWriteSlot();
    }
};
