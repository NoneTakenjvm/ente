import { RemoteEnteFile } from "ente-media/file";
import { z } from "zod";
import type { HttpClient } from "../api/http";

const ObjectUploadURL = z.object({
    objectKey: z.string(),
    url: z.string(),
});

export type ObjectUploadURL = z.infer<typeof ObjectUploadURL>;

export interface UploadedFileObjectAttributes {
    objectKey: string;
    decryptionHeader: string;
    size: number;
}

export interface PostEnteFileRequest {
    collectionID: number;
    encryptedKey: string;
    keyDecryptionNonce: string;
    file: UploadedFileObjectAttributes;
    thumbnail: UploadedFileObjectAttributes;
    metadata: { encryptedData: string; decryptionHeader: string };
    pubMagicMetadata?: {
        version: number;
        count: number;
        data: string;
        header: string;
    };
}

/** Bound PUTs so a stalled S3 connection cannot freeze the batch forever. */
const PUT_FILE_TIMEOUT_MS = 120_000;

/** Optional abort from "Cancel upload" — set for the duration of a batch. */
let batchAbort: AbortController | undefined;

/**
 * Arm a batch-wide abort signal (Cancel upload). Clears any previous controller.
 */
export const beginUploadAbort = (): AbortSignal => {
    batchAbort?.abort();
    batchAbort = new AbortController();
    return batchAbort.signal;
};

/**
 * Abort in-flight PUTs for the current batch.
 */
export const abortUploadBatch = (): void => {
    batchAbort?.abort();
};

/**
 * Clear the batch abort controller after the batch finishes.
 */
export const endUploadAbort = (): void => {
    batchAbort = undefined;
};

const abortableTimeout = (
    ms: number,
    outer?: AbortSignal,
): { signal: AbortSignal; clear: () => void } => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const onOuterAbort = (): void => controller.abort();
    if (outer) {
        if (outer.aborted) {
            controller.abort();
        } else {
            outer.addEventListener("abort", onOuterAbort, { once: true });
        }
    }
    return {
        signal: controller.signal,
        clear: (): void => {
            clearTimeout(timer);
            outer?.removeEventListener("abort", onOuterAbort);
        },
    };
};

/**
 * Mint a pre-signed upload URL bound to content length + MD5.
 *
 * Production museum rejected the legacy bulk `GET /files/upload-urls` (HTTP 410
 * "no longer supported"). Matches official Photos `fetchUploadURLWithMetadata`.
 */
export const fetchUploadURLWithMetadata = async (
    http: HttpClient,
    {
        contentLength,
        contentMd5,
    }: { contentLength: number; contentMd5: string },
): Promise<ObjectUploadURL> => {
    const response = await http.authFetch(
        "/files/upload-url",
        { ts: Date.now() },
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contentLength,
                contentMD5: contentMd5,
            }),
        },
    );
    return ObjectUploadURL.parse(await response.json());
};

const retryableStatus = (status: number): boolean =>
    status === 429 || status >= 500;

const isRetryableError = (error: unknown): boolean => {
    if (error instanceof DOMException && error.name === "AbortError") {
        return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/upload cancelled|upload timed out/i.test(message)) {
        return false;
    }
    // A network-level failure (TypeError from fetch), or a retryable status
    // wrapped by ensureOk's `HTTP <status>` message.
    if (error instanceof TypeError) {
        return true;
    }
    if (/failed to fetch|network|load failed/i.test(message)) {
        return true;
    }
    const statusMatch = /^HTTP (\d{3})/.exec(message);
    return statusMatch ? retryableStatus(Number(statusMatch[1]!)) : false;
};

/**
 * Retry {@link request} on transient failures (5xx, 429, network errors) with
 * bounded exponential backoff.
 *
 * Retrying is safe even when the first attempt partially succeeded: a repeated
 * `PUT` to a pre-signed URL overwrites the same object, and `POST /files`
 * finalize is idempotent on the server (it reuses an existing file with the
 * same object keys). Errors are only thrown once retries are exhausted.
 */
export const withUploadRetry = async <T>(
    request: () => Promise<T>,
    maxAttempts = 4,
): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await request();
        } catch (error) {
            lastError = error;
            if (!isRetryableError(error) || attempt >= maxAttempts) {
                throw error;
            }
            const delayMs = Math.min(8_000, 500 * 2 ** (attempt - 1));
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    throw lastError;
};

const mapAbortError = (error: unknown): never => {
    if (
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && /aborted/i.test(error.message))
    ) {
        if (batchAbort?.signal.aborted) {
            throw new Error("Upload cancelled");
        }
        throw new TypeError("Upload timed out");
    }
    throw error;
};

export interface PutFileOptions {
    contentMd5?: string;
    onProgress?: (loaded: number, total: number) => void;
}

/**
 * Upload encrypted bytes to a pre-signed S3 URL, retrying transient failures.
 *
 * Uses the pre-signed URL directly (no CF upload proxy) — the proxy path was
 * hanging indefinitely on mobile Safari with no usable cancel. When museum
 * minted the URL with checksum metadata, pass the same {@link PutFileOptions.contentMd5}.
 */
export const putFile = async (
    http: HttpClient,
    uploadURL: string,
    fileData: Uint8Array<ArrayBuffer>,
    options?: PutFileOptions,
): Promise<void> => {
    const headers: Record<string, string> = {
        ...http.publicHeaders(),
        ...(options?.contentMd5 ?
            { "Content-MD5": options.contentMd5 } :
            {}),
    };
    const onProgress = options?.onProgress;

    await withUploadRetry(async () => {
        if (!onProgress) {
            const timeout = abortableTimeout(
                PUT_FILE_TIMEOUT_MS,
                batchAbort?.signal,
            );
            try {
                const res = await fetch(uploadURL, {
                    method: "PUT",
                    headers,
                    body: fileData,
                    signal: timeout.signal,
                });
                http.ensureOk(res);
            } catch (error: unknown) {
                mapAbortError(error);
            } finally {
                timeout.clear();
            }
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("PUT", uploadURL);
            for (const [key, value] of Object.entries(headers)) {
                xhr.setRequestHeader(key, value);
            }
            const timer = setTimeout(() => {
                xhr.abort();
            }, PUT_FILE_TIMEOUT_MS);
            const onBatchAbort = (): void => {
                xhr.abort();
            };
            batchAbort?.signal.addEventListener("abort", onBatchAbort, {
                once: true,
            });
            xhr.upload.onprogress = (event: ProgressEvent): void => {
                if (event.lengthComputable) {
                    onProgress(event.loaded, event.total);
                } else {
                    onProgress(
                        event.loaded,
                        Math.max(event.loaded, fileData.byteLength),
                    );
                }
            };
            xhr.onload = (): void => {
                clearTimeout(timer);
                batchAbort?.signal.removeEventListener("abort", onBatchAbort);
                const res = new Response(null, {
                    status: xhr.status,
                    statusText: xhr.statusText,
                });
                try {
                    http.ensureOk(res);
                    onProgress(fileData.byteLength, fileData.byteLength);
                    resolve();
                } catch (error: unknown) {
                    reject(error);
                }
            };
            xhr.onerror = (): void => {
                clearTimeout(timer);
                batchAbort?.signal.removeEventListener("abort", onBatchAbort);
                reject(new TypeError("Failed to fetch"));
            };
            xhr.onabort = (): void => {
                clearTimeout(timer);
                batchAbort?.signal.removeEventListener("abort", onBatchAbort);
                if (batchAbort?.signal.aborted) {
                    reject(new Error("Upload cancelled"));
                } else {
                    reject(new TypeError("Upload timed out"));
                }
            };
            xhr.send(fileData);
        });
    });
};

/**
 * Create a new file record on remote after objects are uploaded, retrying
 * transient failures. The request is idempotent: if the objects were already
 * finalized by a prior attempt, the server returns the existing file.
 */
export const postEnteFile = async (
    http: HttpClient,
    request: PostEnteFileRequest,
): Promise<RemoteEnteFile> => {
    const res = await withUploadRetry(async () => {
        return http.authFetch("/files", undefined, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
        });
    });
    return RemoteEnteFile.parse(await res.json());
};

export interface PutEnteFileUpdateRequest {
    id: number;
    file: UploadedFileObjectAttributes;
    thumbnail: UploadedFileObjectAttributes;
    metadata: { encryptedData: string; decryptionHeader: string };
}

export interface PutEnteFileUpdateResponse {
    id: number;
    updationTime: number;
}

const PutEnteFileUpdateResponseSchema = z.object({
    id: z.number(),
    updationTime: z.number(),
});

/**
 * Replace file + thumbnail bytes for an existing file id (same key, no trash).
 *
 * Mirrors the official app's `PUT /files/update`. Does not touch pub/private
 * magic metadata — callers merge those separately when dimensions or tags
 * change.
 */
export const putEnteFileUpdate = async (
    http: HttpClient,
    request: PutEnteFileUpdateRequest,
): Promise<PutEnteFileUpdateResponse> => {
    const res = await withUploadRetry(async () => {
        return http.authFetch("/files/update", undefined, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
        });
    });
    return PutEnteFileUpdateResponseSchema.parse(await res.json());
};
