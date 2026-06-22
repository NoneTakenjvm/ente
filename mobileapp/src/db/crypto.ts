import {
    decryptMetadataJSON,
    deriveSubKeyBytes,
    encryptMetadataJSON,
    toB64,
} from "ente-base/crypto";

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
 */
export const encryptCachePayload = async (
    data: unknown,
    cacheKey: string,
): Promise<EncryptedPayload> =>
    encryptMetadataJSON(data, cacheKey);

/**
 * Decrypt a payload previously written by {@link encryptCachePayload}.
 */
export const decryptCachePayload = async <T>(
    payload: EncryptedPayload,
    cacheKey: string,
): Promise<T> =>
    decryptMetadataJSON(payload, cacheKey) as Promise<T>;
