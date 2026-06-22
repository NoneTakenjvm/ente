import { getEnteCore } from "@/core";
import { decryptThumbnailCiphertext } from "@/core/download";
import {
    getThumbnailCiphertext,
    putThumbnailCiphertext,
} from "@/db/thumbnails";
import type { EnteFile } from "ente-media/file";

/**
 * Decrypt thumbnail bytes for hashing (IDB first, then network fetch).
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
        await putThumbnailCiphertext(file.id, ciphertext);
        return decryptThumbnailCiphertext(ciphertext, file.key);
    } catch {
        return undefined;
    }
};
