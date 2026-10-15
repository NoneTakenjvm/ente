/// <reference lib="webworker" />

import {
    colorHashFromImageData,
    encodeLuminanceGrid,
    luminanceGridFromImageData,
    type PhashEntry,
} from "@/lib/crop-match";
import { QUALITY_ANALYSIS_MAX, scoreImageQuality } from "@/lib/image-quality";
import { dHashVariantsFromImageData } from "@/lib/phash";
import type {
    AnalyzeThumbnailRequest,
    AnalyzeThumbnailResponse,
    QualityScoreInputs,
} from "@/workers/phash-worker-types";
import { errorMessage } from "@/lib/format";

self.onmessage = async (
    event: MessageEvent<AnalyzeThumbnailRequest>,
): Promise<void> => {
    await handleAnalyzeThumbnail(event.data);
};

/** Decode the thumbnail once, then compute only the requested signals. */
const handleAnalyzeThumbnail = async (
    request: AnalyzeThumbnailRequest,
): Promise<void> => {
    const { id, fileId, bytes, needsPhash, quality } = request;
    try {
        const bitmap = await createImageBitmap(
            new Blob([bytes as BlobPart], { type: "image/jpeg" }),
        );
        const response: AnalyzeThumbnailResponse = { id, fileId };
        try {
            if (needsPhash) {
                response.phashEntry = phashEntryFromBitmap(bitmap);
            }
            if (quality) {
                response.qualityScore = qualityScoreFromBitmap(bitmap, quality);
            }
        } finally {
            bitmap.close();
        }
        self.postMessage(response);
    } catch (error: unknown) {
        const response: AnalyzeThumbnailResponse = {
            id,
            fileId,
            error: errorMessage(error, "Thumbnail analysis failed"),
        };
        self.postMessage(response);
    }
};

const phashEntryFromBitmap = (bitmap: ImageBitmap): PhashEntry => {
    const upright = rasterize(bitmap, bitmap.width, bitmap.height);
    return {
        hashes: dHashVariantsFromImageData(
            upright.data,
            upright.width,
            upright.height,
        ),
        color: colorHashFromImageData(
            upright.data,
            upright.width,
            upright.height,
        ),
        grid: encodeLuminanceGrid(
            luminanceGridFromImageData(
                upright.data,
                upright.width,
                upright.height,
            ),
        ),
    };
};

const qualityScoreFromBitmap = (
    bitmap: ImageBitmap,
    quality: QualityScoreInputs,
): number => {
    const size = qualityAnalysisSize(bitmap.width, bitmap.height);
    // Prefer metadata dimensions; fall back to thumbnail size if missing.
    return scoreImageQuality(
        rasterize(bitmap, size.width, size.height),
        quality.originalWidth > 0 ? quality.originalWidth : bitmap.width,
        quality.originalHeight > 0 ? quality.originalHeight : bitmap.height,
        quality.fileBytes,
    );
};

const qualityAnalysisSize = (
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

const rasterize = (
    bitmap: ImageBitmap,
    width: number,
    height: number,
): ImageData => {
    const context = new OffscreenCanvas(width, height).getContext("2d");
    if (!context) {
        throw new Error("Canvas 2D unavailable in phash worker");
    }
    context.drawImage(bitmap, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
};
