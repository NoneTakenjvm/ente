import { scaledImageDimensions } from "ente-media/image";

const maxThumbnailDimension = 720;
const maxThumbnailSize = 100 * 1024;

const percentageSizeDiff = (
    newThumbnailSize: number,
    oldThumbnailSize: number,
): number =>
    ((oldThumbnailSize - newThumbnailSize) * 100) / oldThumbnailSize;

const compressedJPEGData = async (
    canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<Uint8Array> => {
    let blob: Blob | null = null;
    let prevSize = Number.MAX_SAFE_INTEGER;
    let quality = 0.7;

    do {
        if (blob) {
            prevSize = blob.size;
        }
        if (canvas instanceof OffscreenCanvas) {
            blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
        } else {
            blob = await new Promise<Blob | null>((resolve) => {
                canvas.toBlob((result) => resolve(result), "image/jpeg", quality);
            });
        }
        quality -= 0.1;
    } while (
        quality >= 0.5 &&
        blob &&
        blob.size > maxThumbnailSize &&
        percentageSizeDiff(blob.size, prevSize) >= 10
    );

    if (!blob) {
        throw new Error("Thumbnail generation failed");
    }

    return new Uint8Array(await blob.arrayBuffer());
};

/**
 * Generate a JPEG thumbnail from image bytes.
 */
export const generateImageThumbnail = async (
    imageBytes: Uint8Array,
    mimeType = "image/jpeg",
): Promise<Uint8Array> => {
    const blob = new Blob([imageBytes as BlobPart], { type: mimeType });
    const bitmap = await createImageBitmap(blob);
    const { width, height } = scaledImageDimensions(
        bitmap.width,
        bitmap.height,
        maxThumbnailDimension,
    );

    if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        if (!context) {
            bitmap.close();
            throw new Error("OffscreenCanvas unavailable");
        }
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        return compressedJPEGData(canvas);
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
        bitmap.close();
        throw new Error("Canvas unavailable");
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return compressedJPEGData(canvas);
};
