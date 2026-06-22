/// <reference lib="webworker" />

import type {
    CompressWorkerRequest,
    CompressWorkerResponse,
    CropRect,
} from "@/workers/compress-worker-types";

async function encodeJpeg(
    bytes: Uint8Array,
    quality: number,
    cropRect?: CropRect,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
    const blob: Blob = new Blob([Uint8Array.from(bytes)], {
        type: "image/jpeg",
    });
    const bitmap: ImageBitmap = await createImageBitmap(blob);
    const sourceX: number = cropRect ? Math.round(cropRect.x) : 0;
    const sourceY: number = cropRect ? Math.round(cropRect.y) : 0;
    const outputWidth: number = cropRect ?
        Math.round(cropRect.width) :
        bitmap.width;
    const outputHeight: number = cropRect ?
        Math.round(cropRect.height) :
        bitmap.height;
    const canvas: OffscreenCanvas = new OffscreenCanvas(
        outputWidth,
        outputHeight,
    );
    const context: OffscreenCanvasRenderingContext2D | null =
        canvas.getContext("2d");
    if (!context) {
        bitmap.close();
        throw new Error("OffscreenCanvas unavailable");
    }
    context.drawImage(
        bitmap,
        sourceX,
        sourceY,
        outputWidth,
        outputHeight,
        0,
        0,
        outputWidth,
        outputHeight,
    );
    bitmap.close();
    const jpegBlob: Blob | null = await canvas.convertToBlob({
        type: "image/jpeg",
        quality,
    });
    if (!jpegBlob) {
        throw new Error("JPEG encode failed");
    }
    return {
        bytes: new Uint8Array(await jpegBlob.arrayBuffer()),
        width: outputWidth,
        height: outputHeight,
    };
}

self.onmessage = async (
    event: MessageEvent<CompressWorkerRequest>,
): Promise<void> => {
    const { id, bytes, quality, cropRect }: CompressWorkerRequest = event.data;
    try {
        const result: { bytes: Uint8Array; width: number; height: number } =
            await encodeJpeg(bytes, quality, cropRect);
        const response: CompressWorkerResponse = {
            id,
            bytes: result.bytes,
            width: result.width,
            height: result.height,
        };
        self.postMessage(response);
    } catch (error: unknown) {
        const response: CompressWorkerResponse = {
            id,
            error: error instanceof Error ? error.message : "Encode failed",
        };
        self.postMessage(response);
    }
};
