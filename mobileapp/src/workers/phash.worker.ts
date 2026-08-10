/// <reference lib="webworker" />

import {
    colorHashFromImageData,
    encodeLuminanceGrid,
    luminanceGridFromImageData,
} from "@/lib/crop-match";
import { computeDHashFromImageData } from "@/lib/phash";
import type {
    PhashWorkerRequest,
    PhashWorkerResponse,
} from "@/workers/phash-worker-types";

/**
 * Draw the decoded image into an OffscreenCanvas at the given rotation and
 * mirror, then hash the rendered pixels.
 */
const hashVariant = (
    bitmap: ImageBitmap,
    canvasWidth: number,
    canvasHeight: number,
    rotationDegrees: number,
    mirror: boolean,
): string | undefined => {
    const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
    const context = canvas.getContext("2d");
    if (!context) {
        return undefined;
    }
    context.translate(canvasWidth / 2, canvasHeight / 2);
    context.rotate((rotationDegrees * Math.PI) / 180);
    if (mirror) {
        context.scale(-1, 1);
    }
    context.drawImage(bitmap, -canvasWidth / 2, -canvasHeight / 2);
    const imageData = context.getImageData(0, 0, canvasWidth, canvasHeight);
    return computeDHashFromImageData(imageData.data, canvasWidth, canvasHeight);
};

self.onmessage = async (event: MessageEvent<PhashWorkerRequest>): Promise<void> => {
    const { id, fileId, bytes }: PhashWorkerRequest = event.data;
    try {
        const blob: Blob = new Blob([Uint8Array.from(bytes)], {
            type: "image/jpeg",
        });
        const bitmap: ImageBitmap = await createImageBitmap(blob);

        // Upright render once — the color and grid are orientation-neutral and
        // come from the natural image, not a rotated variant.
        const uprightCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const uprightContext = uprightCanvas.getContext("2d");
        if (!uprightContext) {
            throw new Error("Canvas 2D unavailable in phash worker");
        }
        uprightContext.drawImage(bitmap, 0, 0);
        const uprightData = uprightContext.getImageData(
            0,
            0,
            bitmap.width,
            bitmap.height,
        );
        const color = colorHashFromImageData(
            uprightData.data,
            bitmap.width,
            bitmap.height,
        );
        const grid = encodeLuminanceGrid(
            luminanceGridFromImageData(
                uprightData.data,
                bitmap.width,
                bitmap.height,
            ),
        );

        const hashes: string[] = [];
        for (const rotation of [0, 90, 180, 270]) {
            for (const mirror of [false, true]) {
                const hash = hashVariant(
                    bitmap,
                    bitmap.width,
                    bitmap.height,
                    rotation,
                    mirror,
                );
                if (!hash) {
                    throw new Error("Canvas 2D unavailable in phash worker");
                }
                hashes.push(hash);
            }
        }
        bitmap.close();

        const response: PhashWorkerResponse = { id, fileId, hashes, color, grid };
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
