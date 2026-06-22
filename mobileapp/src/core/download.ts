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

const fetchEncryptedBytes = async (
    http: HttpClient,
    session: CoreSession,
    url: string,
    maxAttempts = 1,
): Promise<Uint8Array> => {
    let attempt = 0;
    while (attempt < maxAttempts) {
        attempt += 1;
        const res = await fetch(url, { headers: http.authHeaders() });
        if (res.status === 429 && attempt < maxAttempts) {
            http.logRateLimitHeaders(res, url);
            await new Promise((resolve) => setTimeout(resolve, retryAfterMs(res) * attempt));
            continue;
        }
        http.ensureOk(res);
        return new Uint8Array(await res.arrayBuffer());
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
 * Download and decrypt full file bytes (images and live photos).
 */
export const getDecryptedFile = async (
    http: HttpClient,
    session: CoreSession,
    file: EnteFile,
): Promise<Uint8Array> => {
    if (!file.file?.decryptionHeader) {
        throw new Error(`File ${file.id} has no file metadata`);
    }

    const origin = http.apiOrigin();
    let encryptedData: Uint8Array;
    if (isProductionEnteOrigin(origin)) {
        encryptedData = await fetchEncryptedBytes(
            http,
            session,
            `https://files.ente.com/?fileID=${file.id}`,
        );
    } else {
        encryptedData = await fetchEncryptedBytes(
            http,
            session,
            `${origin}/files/download/${file.id}?token=${encodeURIComponent(requireAuth(session).authToken)}`,
        );
    }

    return decryptStreamBytes(
        {
            encryptedData: Uint8Array.from(encryptedData),
            decryptionHeader: file.file.decryptionHeader,
        },
        file.key,
    );
};
