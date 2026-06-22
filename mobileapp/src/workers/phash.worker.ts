/// <reference lib="webworker" />

import { computeDHashFromImageData } from "@/lib/phash";
import type {
    PhashWorkerRequest,
    PhashWorkerResponse,
} from "@/workers/phash-worker-types";

self.onmessage = async (event: MessageEvent<PhashWorkerRequest>): Promise<void> => {
    const { id, fileId, bytes }: PhashWorkerRequest = event.data;
    try {
        const blob: Blob = new Blob([Uint8Array.from(bytes)], {
            type: "image/jpeg",
        });
        const bitmap: ImageBitmap = await createImageBitmap(blob);
        const canvas: OffscreenCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context: OffscreenCanvasRenderingContext2D | null =
            canvas.getContext("2d");
        if (!context) {
            throw new Error("OffscreenCanvas unavailable");
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        const imageData: ImageData = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
        );
        const hash: string = computeDHashFromImageData(
            imageData.data,
            canvas.width,
            canvas.height,
        );
        const response: PhashWorkerResponse = { id, fileId, hash };
        self.postMessage(response);
    } catch (error: unknown) {
        const response: PhashWorkerResponse = {
            id,
            fileId,
            error: error instanceof Error ? error.message : "Hash failed",
        };
        self.postMessage(response);
    }
};
