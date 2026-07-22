import {
    decryptBlobBytes,
    decryptStreamBytes,
} from "ente-base/crypto/libsodium";
import type { EnteFile } from "ente-media/file";
import type { HttpClient } from "./api/http";
import { isProductionEnteOrigin } from "./api/http";
import { requireAuth, type CoreSession } from "./session";

export interface ServerCiphertext {
    encryptedData: Uint8Array;
    decryptionHeader: string;
}

/**
 * Byte-level download progress for full-file fetches.
 *
 * {@link total} is 0 when neither Content-Length nor a known size is available.
 */
export interface BytesProgress {
    loaded: number;
    total: number;
}

export type BytesProgressCallback = (progress: BytesProgress) => void;

const retryAfterMs = (res: Response): number => {
    const header = res.headers.get("Retry-After");
    if (!header) {
        return 1000;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
    }
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) {
        return Math.max(0, dateMs - Date.now());
    }
    return 1000;
};

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

    const result = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    onProgress?.({
        loaded,
        total: total > 0 ? total : loaded,
    });
    return result;
};

const fetchEncryptedBytes = async (
    http: HttpClient,
    session: CoreSession,
    url: string,
    maxAttempts = 1,
    onProgress?: BytesProgressCallback,
    knownTotal?: number,
): Promise<Uint8Array> => {
    let attempt = 0;
    while (attempt < maxAttempts) {
        attempt += 1;
        const res = await fetch(url, { headers: http.authHeaders() });
        if (res.status === 429 && attempt < maxAttempts) {
            http.logRateLimitHeaders(res, url);
            await new Promise((resolve) =>
                setTimeout(resolve, retryAfterMs(res) * attempt));
            continue;
        }
        http.ensureOk(res);
        return readResponseBytes(res, onProgress, knownTotal);
    }
    throw new Error(`HTTP 429 for ${url}`);
};

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
        session,
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
): Promise<ServerCiphertext> => {
    if (!file.file?.decryptionHeader) {
        throw new Error(`File ${file.id} has no file metadata`);
    }

    const origin = http.apiOrigin();
    const knownTotal = file.info?.fileSize;
    const encryptedData =
        isProductionEnteOrigin(origin) ?
            await fetchEncryptedBytes(
                http,
                session,
                `https://files.ente.com/?fileID=${file.id}`,
                1,
                onProgress,
                knownTotal,
            ) :
            await fetchEncryptedBytes(
                http,
                session,
                `${origin}/files/download/${file.id}?token=${encodeURIComponent(requireAuth(session).authToken)}`,
                1,
                onProgress,
                knownTotal,
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
            encryptedData: Uint8Array.from(ciphertext.encryptedData),
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
 */
export const getDecryptedFile = async (
    http: HttpClient,
    session: CoreSession,
    file: EnteFile,
    onProgress?: BytesProgressCallback,
): Promise<Uint8Array> => {
    const ciphertext = await fetchEncryptedFile(
        http,
        session,
        file,
        onProgress,
    );
    return decryptFileCiphertext(ciphertext, file.key);
};
