import { withTimeout } from "@/lib/with-timeout";

/** Widest staging preview; grid cells never draw larger than this. */
const maxPreviewWidth = 320;
/** Decodes run two at a time so large originals don't pile up in memory. */
const maxConcurrentDecodes = 2;
/** HEIC can hang {@link createImageBitmap} on some browsers; don't hold a slot forever. */
const decodeTimeoutMs = 20_000;

let activeDecodes = 0;
const decodeWaiters: (() => void)[] = [];

const acquireDecodeSlot = (): Promise<void> => {
    if (activeDecodes < maxConcurrentDecodes) {
        activeDecodes += 1;
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        decodeWaiters.push(resolve);
    });
};

/** Hands the slot to the next waiter, or frees it when nobody is waiting. */
const releaseDecodeSlot = (): void => {
    const next = decodeWaiters.shift();
    if (next) {
        next();
    } else {
        activeDecodes -= 1;
    }
};

/**
 * Decode an image at grid-cell size and return a JPEG object URL for it.
 *
 * At most {@link maxConcurrentDecodes} decodes run at once. If {@link signal}
 * is already aborted when a slot frees up, the decode is skipped. The caller
 * owns the returned URL and must revoke it.
 *
 * @param file the original image; only its decoded thumbnail-sized copy is kept
 * @param cssWidth the cell width in CSS pixels
 * @throws if the decode fails, times out, or is aborted
 */
export const stagingPreviewUrl = async (
    file: Blob,
    cssWidth: number,
    signal: AbortSignal,
): Promise<string> => {
    await acquireDecodeSlot();
    try {
        if (signal.aborted) {
            throw new DOMException("Preview cancelled", "AbortError");
        }
        const targetWidth = Math.min(
            maxPreviewWidth,
            Math.max(1, Math.round(cssWidth * devicePixelRatio)),
        );
        const bitmap = await withTimeout(
            createImageBitmap(file, {
                resizeWidth: targetWidth,
                resizeQuality: "medium",
            }),
            decodeTimeoutMs,
            "Preview decode timed out",
        );
        try {
            // Size from targetWidth, not the bitmap: older Safari ignores
            // resizeWidth and returns the full-size decode.
            const canvas = document.createElement("canvas");
            canvas.width = Math.min(targetWidth, bitmap.width);
            canvas.height = Math.max(
                1,
                Math.round((bitmap.height * canvas.width) / bitmap.width),
            );
            const context = canvas.getContext("2d");
            if (!context) {
                throw new Error("Canvas unavailable");
            }
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise<Blob | null>((resolve) => {
                canvas.toBlob(resolve, "image/jpeg", 0.8);
            });
            if (!blob) {
                throw new Error("Preview encode failed");
            }
            return URL.createObjectURL(blob);
        } finally {
            bitmap.close();
        }
    } finally {
        releaseDecodeSlot();
    }
};
