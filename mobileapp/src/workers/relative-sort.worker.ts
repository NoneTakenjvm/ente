/// <reference lib="webworker" />

import { sortIdsByRelativePacked } from "@/lib/relative-sort-packed";
import { errorMessage } from "@/lib/format";
import type {
    RelativeSortWorkerRequest,
    RelativeSortWorkerResponse,
} from "@/workers/relative-sort-worker-types";

self.onmessage = (event: MessageEvent<RelativeSortWorkerRequest>): void => {
    const { id, mode, seed, startFileId, ids, packed, dim } =
        event.data;
    const post = (order: readonly number[], partial: boolean): void => {
        const orderIds = Float64Array.from(order);
        const response: RelativeSortWorkerResponse = { id, orderIds, partial };
        self.postMessage(response, [orderIds.buffer]);
    };
    try {
        const order = sortIdsByRelativePacked(
            [...ids],
            packed,
            dim,
            mode,
            seed,
            startFileId,
            (orderSoFar) => post(orderSoFar, true),
        );
        post(order, false);
    } catch (error: unknown) {
        const response: RelativeSortWorkerResponse = {
            id,
            error: errorMessage(error, "Relative sort failed"),
        };
        self.postMessage(response);
    }
};
