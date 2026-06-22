import { getEnteCore } from "@/core";
import { decryptThumbnailCiphertext } from "@/core/download";
import {
    getThumbnailCiphertext,
    hasThumbnailCiphertext,
    putThumbnailCiphertext,
} from "@/db/thumbnails";
import { getCachedThumbnailBytes } from "@/lib/thumbnail-cache";
import type { EnteFile } from "ente-media/file";

export const isThumbnailCachedLocally = async (fileId: number): Promise<boolean> =>
    hasThumbnailCiphertext(fileId);

/**
 * Decrypt thumbnail bytes for hashing (memory → IDB → network).
 */
export const getDecryptedThumbnailBytes = async (
    file: EnteFile,
): Promise<Uint8Array | undefined> => {
    try {
        const memoryBytes = await getCachedThumbnailBytes(file.id);
        if (memoryBytes) {
            return memoryBytes;
        }

        const cached = await getThumbnailCiphertext(file.id);
        if (cached) {
            return decryptThumbnailCiphertext(cached, file.key);
        }

        const core = getEnteCore();
        const ciphertext = await core.fetchEncryptedThumbnail(file);
        await putThumbnailCiphertext(file.id, ciphertext);
        return decryptThumbnailCiphertext(ciphertext, file.key);
    } catch {
        return undefined;
    }
};
