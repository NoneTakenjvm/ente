import { deriveCacheKey } from "@/db/crypto";

let sessionCacheKey: string | undefined;

/**
 * Derive and retain the session cache key from the master key.
 */
export const initSessionCacheKey = async (masterKey: string): Promise<string> => {
    sessionCacheKey = await deriveCacheKey(masterKey);
    return sessionCacheKey;
};

export const hasSessionCacheKey = (): boolean => sessionCacheKey !== undefined;

export const getSessionCacheKey = (): string => {
    if (!sessionCacheKey) {
        throw new Error("Cache key not initialized — login required");
    }
    return sessionCacheKey;
};

export const clearSessionCacheKey = (): void => {
    sessionCacheKey = undefined;
};
