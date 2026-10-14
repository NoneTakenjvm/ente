import {
    encryptBlob,
    decryptMetadataJSON,
    deriveSubKeyBytes,
    toB64,
} from "ente-base/crypto";
import { wait } from "ente-utils/promise";

const cacheKeyContext = "enteorg1";
const cacheKeySubKeyID = 1;
const cacheKeyLength = 32;

export interface EncryptedPayload {
    encryptedData: string;
    decryptionHeader: string;
}

/**
 * Derive a session-scoped cache encryption key from the master key.
 *
 * [Note: Local cache key] Never persist the returned key — memory only.
 */
export const deriveCacheKey = async (masterKey: string): Promise<string> => {
    const subKey = await deriveSubKeyBytes(
        masterKey,
        cacheKeyLength,
        cacheKeySubKeyID,
        cacheKeyContext,
    );
    return toB64(subKey);
};

/**
 * Encrypt a JSON-serializable value for IndexedDB storage.
 *
 * Large payloads (full library) stringify on the main thread after a yield,
 * then encrypt the UTF-8 bytes in the crypto worker — avoiding Comlink's
 * structured clone of the whole EnteFile[] graph.
 */
export const encryptCachePayload = async (
    data: unknown,
    cacheKey: string,
): Promise<EncryptedPayload> => {
    // Yield so the UI can paint before a large JSON.stringify blocks.
    await wait(0);
    const json = JSON.stringify(data);
    const bytes = new TextEncoder().encode(json);
    const encrypted = await encryptBlob(bytes, cacheKey);
    return {
        encryptedData: encrypted.encryptedData,
        decryptionHeader: encrypted.decryptionHeader,
    };
};

/**
 * Decrypt a payload previously written by {@link encryptCachePayload}.
 */
export const decryptCachePayload = async <T>(
    payload: EncryptedPayload,
    cacheKey: string,
): Promise<T> =>
    decryptMetadataJSON(payload, cacheKey) as Promise<T>;
