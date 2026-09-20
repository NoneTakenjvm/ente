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
    /** In-flight refill so concurrent workers share one fetch (official UploadService pattern). */
    activeRefill?: Promise<void>;
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

const refillUploadURLs = async (state: BatchUploadState): Promise<void> => {
    if (!state.activeRefill) {
        state.activeRefill = (async (): Promise<void> => {
            const countHint = Math.max(1, state.filesRemaining);
            const urls = await fetchUploadURLs(state.http, countHint);
            state.urls.push(...urls);
        })().finally(() => {
            state.activeRefill = undefined;
        });
    }
    await state.activeRefill;
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

    const state = batchState;
    // Refill under a shared promise so concurrent workers don't stampede;
    // loop in case another worker drained the pool between refill and pop.
    while (state.urls.length === 0) {
        await refillUploadURLs(state);
        if (state.urls.length === 0) {
            throw new Error("Failed to obtain upload URL");
        }
    }

    const url = state.urls.pop();
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
