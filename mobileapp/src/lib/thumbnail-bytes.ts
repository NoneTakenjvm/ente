import { getEnteCore } from "@/core";
import { decryptThumbnailCiphertext } from "@/core/download";
import {
    getThumbnailCiphertext,
    hasThumbnailCiphertext,
    putThumbnailCiphertext,
} from "@/db/thumbnails";
import type { EnteFile } from "ente-media/file";

export const isThumbnailCachedLocally = async (fileId: number): Promise<boolean> =>
    hasThumbnailCiphertext(fileId);

/**
 * Decrypt thumbnail bytes for hashing (IDB → network).
 * Does not re-materialize display blob URLs from the session cache.
 */
export const getDecryptedThumbnailBytes = async (
    file: EnteFile,
): Promise<Uint8Array | undefined> => {
    try {
        const cached = await getThumbnailCiphertext(file.id);
        if (cached) {
            return decryptThumbnailCiphertext(cached, file.key);
        }

        const core = getEnteCore();
        const ciphertext = await core.fetchEncryptedThumbnail(file);
        const bytes = await decryptThumbnailCiphertext(ciphertext, file.key);
        // Persist off the critical path; the put swallows its own errors.
        void putThumbnailCiphertext(file.id, ciphertext);
        return bytes;
    } catch {
        return undefined;
    }
};
