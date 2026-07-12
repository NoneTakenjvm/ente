/// <reference lib="webworker" />

import type {
    BorderScanWorkerRequest,
    BorderScanWorkerResponse,
} from "@/workers/border-scan-worker-types";

const SCAN_MAX_EDGE = 128;
const BORDER_THRESHOLD = 12;
const ALPHA_THRESHOLD = 8;

const isBorderPixel = (
    red: number,
    green: number,
    blue: number,
    alpha: number,
): boolean => {
    if (alpha <= ALPHA_THRESHOLD) {
        return true;
    }
    return (
        red <= BORDER_THRESHOLD &&
        green <= BORDER_THRESHOLD &&
        blue <= BORDER_THRESHOLD
    );
};

/**
 * Coarse letterbox / pillarbox check on a tiny bitmap — false positives are OK;
 * phase 2 recomputes exact bounds on the full image.
 */
const hasCoarseBorder = (imageData: ImageData): boolean => {
    const width: number = imageData.width;
    const height: number = imageData.height;
    const data: Uint8ClampedArray = imageData.data;
    if (width < 8 || height < 8) {
        return false;
    }
    const bandY: number = Math.max(2, Math.floor(height * 0.06));
    const bandX: number = Math.max(2, Math.floor(width * 0.06));

    const rowMostlyBorder = (row: number): boolean => {
        let border: number = 0;
        let samples: number = 0;
        for (let x: number = 0; x < width; x += 2) {
            const index: number = (row * width + x) * 4;
            samples++;
            if (
                isBorderPixel(
                    data[index]!,
                    data[index + 1]!,
                    data[index + 2]!,
                    data[index + 3]!,
                )
            ) {
                border++;
            }
        }
        return samples > 0 && border / samples >= 0.9;
    };

    const colMostlyBorder = (col: number): boolean => {
        let border: number = 0;
        let samples: number = 0;
        for (let y: number = 0; y < height; y += 2) {
            const index: number = (y * width + col) * 4;
            samples++;
            if (
                isBorderPixel(
                    data[index]!,
                    data[index + 1]!,
                    data[index + 2]!,
                    data[index + 3]!,
                )
            ) {
                border++;
            }
        }
        return samples > 0 && border / samples >= 0.9;
    };

    let topBorderRows: number = 0;
    for (let y: number = 0; y < bandY; y++) {
        if (rowMostlyBorder(y)) {
            topBorderRows++;
        }
    }
    let bottomBorderRows: number = 0;
    for (let y: number = height - bandY; y < height; y++) {
        if (rowMostlyBorder(y)) {
            bottomBorderRows++;
        }
    }
    let leftBorderCols: number = 0;
    for (let x: number = 0; x < bandX; x++) {
        if (colMostlyBorder(x)) {
            leftBorderCols++;
        }
    }
    let rightBorderCols: number = 0;
    for (let x: number = width - bandX; x < width; x++) {
        if (colMostlyBorder(x)) {
            rightBorderCols++;
        }
    }

    const minBand: number = Math.max(1, Math.floor(bandY * 0.5));
    const minSide: number = Math.max(1, Math.floor(bandX * 0.5));
    return (
        topBorderRows >= minBand ||
        bottomBorderRows >= minBand ||
        leftBorderCols >= minSide ||
        rightBorderCols >= minSide
    );
};

self.onmessage = async (
    event: MessageEvent<BorderScanWorkerRequest>,
): Promise<void> => {
    const { id, fileId, bytes }: BorderScanWorkerRequest = event.data;
    let bitmap: ImageBitmap | undefined;
    let canvas: OffscreenCanvas | undefined;
    try {
        const blob: Blob = new Blob([Uint8Array.from(bytes)], {
            type: "image/jpeg",
        });
        bitmap = await createImageBitmap(blob, {
            resizeWidth: SCAN_MAX_EDGE,
            resizeQuality: "low",
        });
        canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context: OffscreenCanvasRenderingContext2D | null =
            canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
            throw new Error("OffscreenCanvas unavailable");
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        bitmap = undefined;
        const imageData: ImageData = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
        );
        canvas.width = 0;
        canvas.height = 0;
        canvas = undefined;
        const response: BorderScanWorkerResponse = {
            id,
            fileId,
            hasBorder: hasCoarseBorder(imageData),
        };
        self.postMessage(response);
    } catch (error: unknown) {
        if (bitmap) {
            bitmap.close();
        }
        if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
        }
        const response: BorderScanWorkerResponse = {
            id,
            fileId,
            error: error instanceof Error ? error.message : "Border scan failed",
        };
        self.postMessage(response);
    }
};
