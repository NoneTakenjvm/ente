import {
    DEFAULT_JPEG_QUALITY,
    detectImageFormatFromBytes,
    encodeJpegFromBytes,
    type EncodeJpegResult,
} from "@/lib/compress";

export type PreparedLocalImage = EncodeJpegResult;

/**
 * Prepare image bytes for upload, skipping re-encode when the source is JPEG.
 */
export const prepareLocalImage = async (file: File): Promise<PreparedLocalImage> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (detectImageFormatFromBytes(bytes) === "jpeg") {
        const bitmap = await createImageBitmap(
            new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" }),
        );
        try {
            return {
                bytes,
                width: bitmap.width,
                height: bitmap.height,
            };
        } finally {
            bitmap.close();
        }
    }
    return encodeJpegFromBytes(bytes, DEFAULT_JPEG_QUALITY);
};
