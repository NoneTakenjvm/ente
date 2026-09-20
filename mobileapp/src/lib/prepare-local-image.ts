import { heicToJPEG } from "ente-media/heic-convert";
import {
    DEFAULT_JPEG_QUALITY,
    detectImageFormatFromBytes,
    encodeJpegFromBytes,
    type EncodeJpegResult,
} from "@/lib/compress";
import { blobFromUint8Array } from "@/lib/bytes-blob";
import { withTimeout } from "@/lib/with-timeout";
import { readJpegDimensionsFromBytes } from "@/core/upload/jpeg-dimensions";

export type PreparedLocalImage = EncodeJpegResult;

const IMAGE_BITMAP_TIMEOUT_MS = 20_000;

/**
 * Read JPEG dimensions via SOF markers, falling back to {@link createImageBitmap}.
 */
const readJpegDimensions = async (
    jpegBytes: Uint8Array,
): Promise<PreparedLocalImage> => {
    const fromSof = readJpegDimensionsFromBytes(jpegBytes);
    if (fromSof) {
        return { bytes: jpegBytes, ...fromSof };
    }

    const bitmap = await withTimeout(
        createImageBitmap(blobFromUint8Array(jpegBytes, "image/jpeg")),
        IMAGE_BITMAP_TIMEOUT_MS,
        "Timed out reading image dimensions",
    );
    try {
        return {
            bytes: jpegBytes,
            width: bitmap.width,
            height: bitmap.height,
        };
    } finally {
        bitmap.close();
    }
};

/**
 * Prepare image bytes for upload, skipping re-encode when the source is JPEG.
 *
 * HEIC/HEIF is converted via Wasm first — the compress worker's
 * {@link createImageBitmap} path can hang indefinitely on HEIC in some
 * browsers, which left the upload UI stuck at 0/x.
 */
export const prepareLocalImage = async (
    file: File,
): Promise<PreparedLocalImage> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const format = detectImageFormatFromBytes(bytes);

    if (format === "heic") {
        const jpegBlob = await heicToJPEG(
            blobFromUint8Array(bytes, "image/heic"),
        );
        return readJpegDimensions(new Uint8Array(await jpegBlob.arrayBuffer()));
    }

    if (format === "jpeg") {
        return readJpegDimensions(bytes);
    }

    return encodeJpegFromBytes(bytes, DEFAULT_JPEG_QUALITY);
};
