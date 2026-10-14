/// <reference lib="webworker" />

import {
    areCropMatchesGrids,
    colorHashFromImageData,
    decodeLuminanceGrid,
    encodeLuminanceGrid,
    luminanceGridFromImageData,
    type PhashEntry,
} from "@/lib/crop-match";
import { QUALITY_ANALYSIS_MAX, scoreImageQuality } from "@/lib/image-quality";
import { dHashVariantsFromImageData } from "@/lib/phash";
import { runStage1Clustering } from "@/lib/similarity-stage1-core";
import type { Stage1ClipOptions } from "@/lib/similarity-stage1-core";
import type {
    AnalyzeThumbnailRequest,
    AnalyzeThumbnailResponse,
    CropCheckBatchMessage,
    CropCheckBatchResult,
    PhashWorkerInbound,
    QualityScoreInputs,
    Stage1AbortMessage,
    Stage1Message,
    Stage1ProgressMessage,
    Stage1ResultMessage,
} from "@/workers/phash-worker-types";
import { errorMessage } from "@/lib/format";

const abortedStage1Ids = new Set<number>();

const handleStage1 = async (message: Stage1Message): Promise<void> => {
    abortedStage1Ids.delete(message.id);
    try {
        let clip: Stage1ClipOptions | undefined;
        if (message.embeddings) {
            const { vectors, fileIds, dims } = message.embeddings;
            const embeddings = new Map<number, Float32Array>();
            for (let row = 0; row < fileIds.length; row++) {
                embeddings.set(
                    fileIds[row]!,
                    vectors.subarray(row * dims, (row + 1) * dims),
                );
            }
            if (embeddings.size > 0) {
                clip = { embeddings };
            }
        }
        const { clusters, edges } = await runStage1Clustering(
            message.items,
            message.threshold,
            (update) => {
                const progress: Stage1ProgressMessage = {
                    kind: "stage1-progress",
                    id: message.id,
                    update,
                };
                self.postMessage(progress);
            },
            () => abortedStage1Ids.has(message.id),
            undefined,
            clip,
        );
        if (abortedStage1Ids.has(message.id)) {
            abortedStage1Ids.delete(message.id);
            return;
        }
        const result: Stage1ResultMessage = {
            kind: "stage1-result",
            id: message.id,
            clusters,
            edges,
        };
        self.postMessage(result);
    } catch (error: unknown) {
        if (
            error instanceof DOMException &&
            error.name === "AbortError"
        ) {
            abortedStage1Ids.delete(message.id);
            return;
        }
        const result: Stage1ResultMessage = {
            kind: "stage1-result",
            id: message.id,
            error: errorMessage(error, "Stage-1 failed"),
        };
        self.postMessage(result);
    }
};

self.onmessage = async (
    event: MessageEvent<PhashWorkerInbound>,
): Promise<void> => {
    const message = event.data;

    if (message.kind === "stage1-abort") {
        const abort = message as Stage1AbortMessage;
        abortedStage1Ids.add(abort.id);
        return;
    }

    if (message.kind === "stage1") {
        await handleStage1(message);
        return;
    }

    if (message.kind === "crop-check-batch") {
        const batch = message as CropCheckBatchMessage;
        try {
            const decoded = new Map<
                string,
                { color: string; grid: Uint8Array }
            >();
            for (const [key, entry] of Object.entries(batch.entries)) {
                decoded.set(key, {
                    color: entry.color,
                    grid: decodeLuminanceGrid(entry.grid),
                });
            }
            const matches = batch.pairs.map(([aKey, bKey]) => {
                const left = decoded.get(aKey);
                const right = decoded.get(bKey);
                if (!left || !right) {
                    return false;
                }
                return areCropMatchesGrids(
                    left.color,
                    left.grid,
                    right.color,
                    right.grid,
                );
            });
            const response: CropCheckBatchResult = {
                kind: "crop-check-batch",
                id: batch.id,
                matches,
            };
            self.postMessage(response);
        } catch (error: unknown) {
            const response: CropCheckBatchResult = {
                kind: "crop-check-batch",
                id: batch.id,
                matches: batch.pairs.map(() => false),
                error:
                    errorMessage(error, "Crop batch failed"),
            };
            self.postMessage(response);
        }
        return;
    }

    await handleAnalyzeThumbnail(message);
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
