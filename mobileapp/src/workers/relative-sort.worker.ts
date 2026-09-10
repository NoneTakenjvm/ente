/// <reference lib="webworker" />

import { sortIdsByRelativePacked } from "@/lib/relative-sort-packed";

interface RelativeSortWorkerRequest {
    requestId: number;
    mode: "closest" | "furthest";
    seed: number;
    startFileId?: number;
    /** File ids (Float64 — must not use Int32; Ente ids overflow signed 32-bit). */
    ids: Float64Array;
    packed: Float32Array;
    dim: number;
}

interface RelativeSortWorkerResponse {
    requestId: number;
    orderIds?: Float64Array;
    error?: string;
}

self.onmessage = (event: MessageEvent<RelativeSortWorkerRequest>): void => {
    const { requestId, mode, seed, startFileId, ids, packed, dim } =
        event.data;
    try {
        const order = sortIdsByRelativePacked(
            [...ids],
            packed,
            dim,
            mode,
            seed,
            startFileId,
        );
        const orderIds = Float64Array.from(order);
        const response: RelativeSortWorkerResponse = { requestId, orderIds };
        self.postMessage(response, [orderIds.buffer]);
    } catch (error: unknown) {
        const response: RelativeSortWorkerResponse = {
            requestId,
            error: error instanceof Error ? error.message : "Relative sort failed",
        };
        self.postMessage(response);
    }
};
