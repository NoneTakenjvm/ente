import { getEnteCore } from "@/core";
import type {
    BytesProgressCallback,
    ServerCiphertext,
} from "@/core/download";
import {
    deleteFileCiphertext,
    getFileCiphertext,
    putFileCiphertext,
} from "@/db/file-ciphertexts";
import type { EnteFile } from "ente-media/file";

/** Soft cap on decrypted video blob URLs retained in RAM this session. */
const SESSION_BUDGET_BYTES = 120 * 1024 * 1024;

interface SessionVideoEntry {
    url: string;
    byteSize: number;
    lastAccess: number;
}

const sessionCache = new Map<number, SessionVideoEntry>();

const sessionBytesUsed = (): number => {
    let total = 0;
    for (const entry of sessionCache.values()) {
        total += entry.byteSize;
    }
    return total;
};

const evictSessionUntilFit = (incomingBytes: number): void => {
    if (incomingBytes > SESSION_BUDGET_BYTES) {
        for (const [fileId, entry] of sessionCache) {
            URL.revokeObjectURL(entry.url);
            sessionCache.delete(fileId);
        }
        return;
    }
    const ranked = [...sessionCache.entries()].sort(
        (a, b) => a[1].lastAccess - b[1].lastAccess,
    );
    let used = sessionBytesUsed();
    for (const [fileId, entry] of ranked) {
        if (used + incomingBytes <= SESSION_BUDGET_BYTES) {
            break;
        }
        URL.revokeObjectURL(entry.url);
        sessionCache.delete(fileId);
        used -= entry.byteSize;
    }
};

/**
 * Keep a video blob URL after it leaves the carousel ±1 window.
 */
export const retainSessionVideoUrl = (
    fileId: number,
    url: string,
    byteSize: number,
): void => {
    const size = Math.max(0, byteSize);
    const existing = sessionCache.get(fileId);
    if (existing) {
        if (existing.url !== url) {
            URL.revokeObjectURL(existing.url);
        }
        sessionCache.set(fileId, {
            url,
            byteSize: size > 0 ? size : existing.byteSize,
            lastAccess: Date.now(),
        });
        return;
    }
    evictSessionUntilFit(size);
    sessionCache.set(fileId, {
        url,
        byteSize: size,
        lastAccess: Date.now(),
    });
};

/**
 * Return a session-cached video blob URL if present (and touch LRU).
 * Does not transfer ownership — prefer {@link takeSessionVideoUrl} for the viewer.
 */
export const peekSessionVideo = (
    fileId: number,
): { url: string; byteSize: number } | undefined => {
    const entry = sessionCache.get(fileId);
    if (!entry) {
        return undefined;
    }
    entry.lastAccess = Date.now();
    return { url: entry.url, byteSize: entry.byteSize };
};

/**
 * Remove a session entry and return it so the caller owns the blob URL.
 * Prevents the session LRU from revoking a URL still shown in the carousel.
 */
export const takeSessionVideoUrl = (
    fileId: number,
): { url: string; byteSize: number } | undefined => {
    const entry = sessionCache.get(fileId);
    if (!entry) {
        return undefined;
    }
    sessionCache.delete(fileId);
    return { url: entry.url, byteSize: entry.byteSize };
};

/**
 * Remove a session entry without revoking the URL (caller takes ownership).
 */
export const forgetSessionVideoUrl = (fileId: number): string | undefined => {
    const entry = sessionCache.get(fileId);
    if (!entry) {
        return undefined;
    }
    sessionCache.delete(fileId);
    return entry.url;
};

/**
 * Move a session blob URL from one file id to another without revoking it.
 */
export const transferSessionVideoUrl = (
    fromFileId: number,
    toFileId: number,
): void => {
    const entry = sessionCache.get(fromFileId);
    if (!entry) {
        return;
    }
    sessionCache.delete(fromFileId);
    const existing = sessionCache.get(toFileId);
    if (existing && existing.url !== entry.url) {
        URL.revokeObjectURL(existing.url);
    }
    sessionCache.set(toFileId, {
        ...entry,
        lastAccess: Date.now(),
    });
};

export const clearVideoSessionCache = (): void => {
    for (const entry of sessionCache.values()) {
        URL.revokeObjectURL(entry.url);
    }
    sessionCache.clear();
};

/**
 * Drop session + disk cache entries for a file (e.g. after trash).
 * Revokes any session blob URL for {@link fileId}.
 */
export const invalidateVideoCache = (fileId: number): void => {
    const entry = sessionCache.get(fileId);
    if (entry) {
        URL.revokeObjectURL(entry.url);
        sessionCache.delete(fileId);
    }
    void deleteFileCiphertext(fileId);
};

/**
 * Clear disk ciphertext only — keep any session blob URL (e.g. during replace
 * while the viewer still displays it under a remapped id).
 */
export const clearVideoDiskCache = (fileId: number): void => {
    void deleteFileCiphertext(fileId);
};

/**
 * Load decrypted video bytes: disk ciphertext → network, then decrypt.
 * Persists freshly downloaded ciphertext for cold-start reuse.
 */
export const loadCachedVideoBytes = async (
    file: EnteFile,
    onProgress?: BytesProgressCallback,
): Promise<Uint8Array> => {
    const core = getEnteCore();
    const cached = await getFileCiphertext(file.id);
    if (cached) {
        onProgress?.({
            loaded: cached.encryptedData.byteLength,
            total: cached.encryptedData.byteLength,
        });
        return core.decryptFileCiphertext(cached, file.key);
    }

    const ciphertext: ServerCiphertext = await core.fetchEncryptedFile(
        file,
        onProgress,
    );
    void putFileCiphertext(file.id, ciphertext);
    return core.decryptFileCiphertext(ciphertext, file.key);
};
