import { RemoteEnteFile } from "ente-media/file";
import { z } from "zod";
import type { HttpClient } from "../api/http";

const ObjectUploadURL = z.object({
    objectKey: z.string(),
    url: z.string(),
});

export type ObjectUploadURL = z.infer<typeof ObjectUploadURL>;

const ObjectUploadURLResponse = z.object({
    urls: ObjectUploadURL.array(),
});

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

/**
 * Fetch pre-signed URLs for uploading multiple objects.
 */
export const fetchUploadURLs = async (
    http: HttpClient,
    countHint: number,
): Promise<ObjectUploadURL[]> => {
    const count = Math.min(50, countHint * 2);
    const response = await http.authFetchJSON<{ urls: ObjectUploadURL[] }>(
        "/files/upload-urls",
        { count, ts: Date.now() },
    );
    const parsed = ObjectUploadURLResponse.parse(response);
    return parsed.urls;
};

/**
 * Fetch a pre-signed URL for uploading one object.
 */
export const fetchUploadURL = async (
    http: HttpClient,
): Promise<ObjectUploadURL> => {
    const urls = await fetchUploadURLs(http, 1);
    const url = urls[0];
    if (!url) {
        throw new Error("Failed to obtain upload URL");
    }
    return url;
};

const retryableStatus = (status: number): boolean =>
    status === 429 || status >= 500;

const isRetryableError = (error: unknown): boolean => {
    // A network-level failure (TypeError from fetch), or a retryable status
    // wrapped by ensureOk's `HTTP <status>` message.
    if (error instanceof TypeError) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
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

/**
 * Upload encrypted bytes to a pre-signed S3 URL, retrying transient failures.
 *
 * When {@link onProgress} is set, uses XHR so upload byte progress is available
 * (fetch does not report request-body progress).
 */
export const putFile = async (
    http: HttpClient,
    uploadURL: string,
    fileData: Uint8Array<ArrayBuffer>,
    onProgress?: (loaded: number, total: number) => void,
): Promise<void> => {
    await withUploadRetry(async () => {
        if (!onProgress) {
            const res = await fetch(uploadURL, {
                method: "PUT",
                headers: http.publicHeaders(),
                body: fileData,
            });
            http.ensureOk(res);
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("PUT", uploadURL);
            const headers = http.publicHeaders();
            for (const [key, value] of Object.entries(headers)) {
                xhr.setRequestHeader(key, value);
            }
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
                reject(new TypeError("Failed to fetch"));
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
