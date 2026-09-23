import type { HttpClient } from "../api/http";
import { computeMd5Base64 } from "./md5";
import {
    fetchUploadURLWithMetadata,
    putFile,
    type ObjectUploadURL,
} from "./remote";

/**
 * Mint a checksum-bound upload URL for encrypted object bytes.
 *
 * Replaces the legacy bulk URL pool — production museum returns HTTP 410 for
 * `GET /files/upload-urls`.
 */
export const takeUploadURL = async (
    http: HttpClient,
    encryptedBytes: Uint8Array,
): Promise<{ upload: ObjectUploadURL; contentMd5: string }> => {
    const contentMd5 = computeMd5Base64(encryptedBytes);
    const upload = await fetchUploadURLWithMetadata(http, {
        contentLength: encryptedBytes.length,
        contentMd5,
    });
    return { upload, contentMd5 };
};

/**
 * Mint URL + PUT encrypted bytes with matching Content-MD5.
 */
export const putEncryptedObject = async (
    http: HttpClient,
    encryptedBytes: Uint8Array<ArrayBuffer>,
    onProgress?: (loaded: number, total: number) => void,
): Promise<ObjectUploadURL> => {
    const { upload, contentMd5 } = await takeUploadURL(http, encryptedBytes);
    await putFile(http, upload.url, encryptedBytes, {
        contentMd5,
        onProgress,
    });
    return upload;
};

/** No-op retained so callers can keep batch try/finally structure. */
export const beginUploadBatch = async (
    _http: HttpClient,
    _fileCount: number,
): Promise<void> => {
    // Checksum URLs are minted per object after encrypt; nothing to prefetch.
};

/** No-op — see {@link beginUploadBatch}. */
export const markBatchUploadFileComplete = (): void => {};

/** No-op — see {@link beginUploadBatch}. */
export const endUploadBatch = (): void => {};
