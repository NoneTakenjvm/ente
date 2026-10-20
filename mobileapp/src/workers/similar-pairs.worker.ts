/// <reference lib="webworker" />

import { collectClipPairs } from "@/lib/similarity-clip";
import { errorMessage } from "@/lib/format";
import type {
    SimilarPairsWorkerRequest,
    SimilarPairsWorkerResponse,
} from "@/workers/similar-pairs-worker-types";

self.onmessage = (event: MessageEvent<SimilarPairsWorkerRequest>): void => {
    const { id, fileIds, packed, dims, maxScore, queryCount } = event.data;
    const total = queryCount;
    // About a hundred progress replies per scan.
    const progressEvery = Math.max(1, Math.floor(total / 100));
    try {
        const pairs = collectClipPairs(
            fileIds,
            packed,
            dims,
            maxScore,
            (completed) => {
                if (completed % progressEvery === 0) {
                    const progress: SimilarPairsWorkerResponse = {
                        id,
                        partial: true,
                        completed,
                        total,
                    };
                    self.postMessage(progress);
                }
            },
            queryCount,
        );
        const response: SimilarPairsWorkerResponse = { id, pairs };
        self.postMessage(response, [
            pairs.leftIds.buffer,
            pairs.rightIds.buffer,
            pairs.scores.buffer,
        ]);
    } catch (error: unknown) {
        const response: SimilarPairsWorkerResponse = {
            id,
            error: errorMessage(error, "Similar scan failed"),
        };
        self.postMessage(response);
    }
};
