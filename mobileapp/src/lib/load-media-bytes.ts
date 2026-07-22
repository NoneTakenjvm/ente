import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import { getEnteCore } from "@/core";
import type { BytesProgressCallback } from "@/core/download";
import { getLocalMediaOverride } from "@/lib/local-media-overrides";
import { loadCachedVideoBytes } from "@/lib/video-media-cache";

/**
 * Load decrypted media bytes for compress/edit, preferring local override and
 * the video disk ciphertext cache when applicable.
 */
export const loadMediaBytesForEdit = async (
    file: EnteFile,
    onProgress?: BytesProgressCallback,
): Promise<Uint8Array> => {
    const override = getLocalMediaOverride(file.id);
    if (override) {
        onProgress?.({
            loaded: override.byteLength,
            total: override.byteLength,
        });
        return override;
    }
    if (file.metadata.fileType === FileType.video) {
        return loadCachedVideoBytes(file, onProgress);
    }
    return getEnteCore().getDecryptedFile(file, onProgress);
};
