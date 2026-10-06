/// <reference lib="webworker" />

import {
    areCropMatches,
    areCropMatchesGrids,
    colorHashFromImageData,
    decodeLuminanceGrid,
    encodeLuminanceGrid,
    luminanceGridFromImageData,
} from "@/lib/crop-match";
import { dHashVariantsFromImageData } from "@/lib/phash";
import { runStage1Clustering } from "@/lib/similarity-stage1-core";
import type { Stage1ClipOptions } from "@/lib/similarity-stage1-core";
import type {
    CropCheckBatchMessage,
    CropCheckBatchResult,
    CropCheckMessage,
    CropCheckResult,
    PhashWorkerInbound,
    PhashWorkerRequest,
    PhashWorkerResponse,
    Stage1AbortMessage,
    Stage1Message,
    Stage1ProgressMessage,
    Stage1ResultMessage,
} from "@/workers/phash-worker-types";

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
            error: error instanceof Error ? error.message : "Stage-1 failed",
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

    // Crop verification: pure string decode + template match, off the UI thread.
    if (message.kind === "crop-check") {
        const { id, aColor, aGrid, bColor, bGrid } = message as CropCheckMessage;
        try {
            const match = areCropMatches(aColor, aGrid, bColor, bGrid);
            const response: CropCheckResult = { kind: "crop-check", id, match };
            self.postMessage(response);
        } catch (error: unknown) {
            const response: CropCheckResult = {
                kind: "crop-check",
                id,
                match: false,
                error: error instanceof Error ? error.message : "Crop check failed",
            };
            self.postMessage(response);
        }
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
                    error instanceof Error ? error.message : "Crop batch failed",
            };
            self.postMessage(response);
        }
        return;
    }

    const { id, fileId, bytes }: PhashWorkerRequest = message;
    try {
        const blob: Blob = new Blob([bytes as BlobPart], {
            type: "image/jpeg",
        });
        const bitmap: ImageBitmap = await createImageBitmap(blob);

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
        bitmap.close();
        const color = colorHashFromImageData(
            uprightData.data,
            uprightData.width,
            uprightData.height,
        );
        const grid = encodeLuminanceGrid(
            luminanceGridFromImageData(
                uprightData.data,
                uprightData.width,
                uprightData.height,
            ),
        );

        const hashes = dHashVariantsFromImageData(
            uprightData.data,
            uprightData.width,
            uprightData.height,
        );

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
