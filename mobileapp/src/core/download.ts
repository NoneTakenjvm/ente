import { ensureArrayBufferBacked } from "ente-base/bytes";
import {
    decryptBlobBytes,
    decryptStreamBytes,
} from "ente-base/crypto/libsodium";
import type { EnteFile } from "ente-media/file";
import type { HttpClient } from "./api/http";
import {
    isProductionEnteOrigin,
    isTransientError,
    retryWithBackoff,
} from "./api/http";
import { requireAuth, type CoreSession } from "./session";
import { mergeUint8Arrays } from "ente-utils/array";

export interface ServerCiphertext {
    encryptedData: Uint8Array;
    decryptionHeader: string;
}

/**
 * Byte-level download progress for full-file fetches.
 *
 * {@link total} is 0 when neither Content-Length nor a known size is available.
 */
interface BytesProgress {
    loaded: number;
    total: number;
}

export type BytesProgressCallback = (progress: BytesProgress) => void;

/**
 * Read a fetch {@link Response} body into a single buffer, optionally reporting
 * download progress. Progress percent is throttled to whole-percentage steps
 * when {@link total} is known.
 */
const readResponseBytes = async (
    res: Response,
    onProgress?: BytesProgressCallback,
    knownTotal?: number,
): Promise<Uint8Array> => {
    const contentLengthHeader = res.headers.get("Content-Length");
    const contentLength = contentLengthHeader ?
        Number.parseInt(contentLengthHeader, 10) :
        Number.NaN;
    const total =
        Number.isFinite(contentLength) && contentLength > 0 ?
            contentLength :
            knownTotal && knownTotal > 0 ?
                knownTotal :
                0;

    if (!res.body) {
        const buffer = new Uint8Array(await res.arrayBuffer());
        onProgress?.({
            loaded: buffer.byteLength,
            total: total > 0 ? total : buffer.byteLength,
        });
        return buffer;
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    let lastReportedPercent = -1;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        loaded += value.byteLength;
        if (!onProgress) {
            continue;
        }
        if (total > 0) {
            const percent = Math.min(100, Math.floor((loaded / total) * 100));
            if (percent === lastReportedPercent) {
                continue;
            }
            lastReportedPercent = percent;
        }
        onProgress({ loaded, total });
    }

    onProgress?.({
        loaded,
        total: total > 0 ? total : loaded,
    });
    return mergeUint8Arrays(chunks);
};

/**
 * Fetch encrypted bytes, retrying 429, 5xx, and network failures up to
 * {@link maxAttempts} times. Other 4xx responses and aborts fail immediately.
 */
const fetchEncryptedBytes = (
    http: HttpClient,
    url: string,
    maxAttempts = 1,
    onProgress?: BytesProgressCallback,
    knownTotal?: number,
    signal?: AbortSignal,
): Promise<Uint8Array> =>
    retryWithBackoff(
        async () => {
            const res = await fetch(url, { headers: http.authHeaders(), signal });
            http.ensureOk(res);
            return readResponseBytes(res, onProgress, knownTotal);
        },
        {
            attempts: maxAttempts,
            isRetryable: isTransientError,
            baseDelayMs: 500,
            signal,
        },
    );

const thumbnailUrl = (
    http: HttpClient,
    session: CoreSession,
    fileId: number,
): string => {
    const origin = http.apiOrigin();
    if (isProductionEnteOrigin(origin)) {
        return `https://thumbnails.ente.com/?fileID=${fileId}`;
    }
    return `${origin}/files/preview/${fileId}?token=${encodeURIComponent(requireAuth(session).authToken)}`;
};

/**
 * Download encrypted thumbnail bytes from remote (before decryption).
 */
export const fetchEncryptedThumbnail = async (
    http: HttpClient,
    session: CoreSession,
    file: EnteFile,
): Promise<ServerCiphertext> => {
    if (!file.thumbnail?.decryptionHeader) {
        throw new Error(`File ${file.id} has no thumbnail metadata`);
    }

    const encryptedData = await fetchEncryptedBytes(
        http,
        thumbnailUrl(http, session, file.id),
        4,
    );

    return {
        encryptedData,
        decryptionHeader: file.thumbnail.decryptionHeader,
    };
};

/**
 * Decrypt server ciphertext into thumbnail bytes.
 */
export const decryptThumbnailCiphertext = async (
    ciphertext: ServerCiphertext,
    fileKey: string,
): Promise<Uint8Array> =>
    decryptBlobBytes(
        {
            encryptedData: ciphertext.encryptedData,
            decryptionHeader: ciphertext.decryptionHeader,
        },
        fileKey,
    );

/**
 * Download and decrypt the thumbnail for an {@link EnteFile}.
 */
export const getDecryptedThumbnail = async (
    http: HttpClient,
    session: CoreSession,
    file: EnteFile,
): Promise<Uint8Array> => {
    const ciphertext = await fetchEncryptedThumbnail(http, session, file);
    return decryptThumbnailCiphertext(ciphertext, file.key);
};

/**
 * Download encrypted full-file bytes from remote (before decryption).
 */
export const fetchEncryptedFile = async (
    http: HttpClient,
    session: CoreSession,
    file: EnteFile,
    onProgress?: BytesProgressCallback,
    signal?: AbortSignal,
): Promise<ServerCiphertext> => {
    if (!file.file?.decryptionHeader) {
        throw new Error(`File ${file.id} has no file metadata`);
    }

    const origin = http.apiOrigin();
    const url = isProductionEnteOrigin(origin) ?
        `https://files.ente.com/?fileID=${file.id}` :
        `${origin}/files/download/${file.id}?token=${encodeURIComponent(requireAuth(session).authToken)}`;
    const encryptedData = await fetchEncryptedBytes(
        http,
        url,
        3,
        onProgress,
        file.info?.fileSize,
        signal,
    );

    return {
        encryptedData,
        decryptionHeader: file.file.decryptionHeader,
    };
};

/**
 * Decrypt server ciphertext into full-file bytes.
 */
export const decryptFileCiphertext = async (
    ciphertext: ServerCiphertext,
    fileKey: string,
): Promise<Uint8Array> =>
    decryptStreamBytes(
        {
            encryptedData: ensureArrayBufferBacked(ciphertext.encryptedData),
            decryptionHeader: ciphertext.decryptionHeader,
        },
        fileKey,
    );

/**
 * Download and decrypt full file bytes (images, videos, and live photos).
 *
 * When {@link onProgress} is provided, it reports encrypted-byte download
 * progress (not decrypt/convert). Prefer Content-Length; fall back to
 * {@link EnteFile.info.fileSize} when the header is missing.
 *
 * Aborting {@link signal} cancels the download and rejects with an
 * `AbortError`.
 */
export const getDecryptedFile = async (
    http: HttpClient,
    session: CoreSession,
    file: EnteFile,
    onProgress?: BytesProgressCallback,
    signal?: AbortSignal,
): Promise<Uint8Array> => {
    const ciphertext = await fetchEncryptedFile(
        http,
        session,
        file,
        onProgress,
        signal,
    );
    return decryptFileCiphertext(ciphertext, file.key);
};
