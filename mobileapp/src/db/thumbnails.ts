import { isGalleryScrolling } from "@/lib/gallery-scroll-activity";
import { createLruBlobStore } from "./blob-store";
import type { ThumbnailRecord } from "./index";

export interface ServerCiphertext {
    encryptedData: Uint8Array;
    decryptionHeader: string;
}

const thumbnailStore = createLruBlobStore<ThumbnailRecord>({
    storeName: "thumbnails",
    budgetBytes: 400 * 1024 * 1024,
    // Bulk fetches (hash / CLIP jobs) scan the store once per ~80 MB.
    targetBytes: 320 * 1024 * 1024,
    touchMinIntervalMs: 5 * 60 * 1000,
    suppressTouch: isGalleryScrolling,
});

export const hasThumbnailCiphertext = (fileId: number): Promise<boolean> =>
    thumbnailStore.has(fileId);

export const getThumbnailCiphertext = async (
    fileId: number,
): Promise<ServerCiphertext | undefined> => {
    const record = await thumbnailStore.get(fileId);
    return record && {
        encryptedData: new Uint8Array(record.encryptedData),
        decryptionHeader: record.decryptionHeader,
    };
};

export const putThumbnailCiphertext = async (
    fileId: number,
    ciphertext: ServerCiphertext,
): Promise<void> => {
    await thumbnailStore.put({
        fileId,
        encryptedData: ciphertext.encryptedData.slice().buffer,
        decryptionHeader: ciphertext.decryptionHeader,
        byteSize: ciphertext.encryptedData.byteLength,
    });
};

export const deleteThumbnailCiphertext = (fileId: number): Promise<void> =>
    thumbnailStore.delete(fileId);
