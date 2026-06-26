import type { HttpClient } from "../api/http";
import {
    fetchUploadURL,
    fetchUploadURLs,
    type ObjectUploadURL,
} from "./remote";

interface BatchUploadState {
    http: HttpClient;
    urls: ObjectUploadURL[];
    filesRemaining: number;
}

let batchState: BatchUploadState | undefined;

/**
 * Prefetch upload URLs for a multi-file upload batch.
 */
export const beginUploadBatch = async (
    http: HttpClient,
    fileCount: number,
): Promise<void> => {
    batchState = {
        http,
        urls: await fetchUploadURLs(http, fileCount),
        filesRemaining: fileCount,
    };
};

/**
 * Take the next pre-signed upload URL from the batch pool.
 */
export const takeUploadURL = async (
    http: HttpClient,
): Promise<ObjectUploadURL> => {
    if (!batchState) {
        return fetchUploadURL(http);
    }

    if (batchState.urls.length === 0) {
        const countHint = Math.max(1, batchState.filesRemaining);
        const urls = await fetchUploadURLs(batchState.http, countHint);
        batchState.urls.push(...urls);
    }

    const url = batchState.urls.pop();
    if (!url) {
        throw new Error("Failed to obtain upload URL");
    }
    return url;
};

/**
 * Mark one file in the batch as finished (file + thumbnail uploaded).
 */
export const markBatchUploadFileComplete = (): void => {
    if (batchState) {
        batchState.filesRemaining = Math.max(0, batchState.filesRemaining - 1);
    }
};

/**
 * Clear batch upload URL pool state.
 */
export const endUploadBatch = (): void => {
    batchState = undefined;
};
