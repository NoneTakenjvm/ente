/// <reference lib="webworker" />

import {
    QUALITY_ANALYSIS_MAX,
    scoreImageQuality,
} from "@/lib/image-quality";

export interface ImageQualityWorkerRequest {
    id: number;
    fileId: number;
    bytes: Uint8Array;
    originalWidth: number;
    originalHeight: number;
    fileBytes: number;
}

export interface ImageQualityWorkerResponse {
    id: number;
    fileId: number;
    score?: number;
    error?: string;
}

const analysisSize = (
    width: number,
    height: number,
): { width: number; height: number } => {
    const longEdge = Math.max(width, height);
    if (longEdge <= QUALITY_ANALYSIS_MAX) {
        return { width, height };
    }
    const scale = QUALITY_ANALYSIS_MAX / longEdge;
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
};

self.onmessage = async (
    event: MessageEvent<ImageQualityWorkerRequest>,
): Promise<void> => {
    const { id, fileId, bytes, originalWidth, originalHeight, fileBytes } =
        event.data;
    try {
        const blob = new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(blob);
        const sized = analysisSize(bitmap.width, bitmap.height);
        const canvas = new OffscreenCanvas(sized.width, sized.height);
        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Canvas 2D unavailable in quality worker");
        }
        context.drawImage(bitmap, 0, 0, sized.width, sized.height);
        const imageData = context.getImageData(0, 0, sized.width, sized.height);
        const thumbW = bitmap.width;
        const thumbH = bitmap.height;
        bitmap.close();

        // Prefer metadata dimensions; fall back to thumbnail size if missing.
        const score = scoreImageQuality(
            imageData,
            originalWidth > 0 ? originalWidth : thumbW,
            originalHeight > 0 ? originalHeight : thumbH,
            fileBytes,
        );

        const response: ImageQualityWorkerResponse = { id, fileId, score };
        self.postMessage(response);
    } catch (error: unknown) {
        const response: ImageQualityWorkerResponse = {
            id,
            fileId,
            error: error instanceof Error ? error.message : "Quality score failed",
        };
        self.postMessage(response);
    }
};
