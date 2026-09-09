import { KIT_EMBEDDING_DIMS } from "@/lib/kit-embedding";
import type { RelativePackedMode } from "@/lib/relative-sort-packed";

interface RelativeSortWorkerRequest {
    requestId: number;
    mode: RelativePackedMode;
    seed: number;
    startFileId?: number;
    ids: Int32Array;
    packed: Float32Array;
    dim: number;
}

interface RelativeSortWorkerResponse {
    requestId: number;
    orderIds?: Int32Array;
    error?: string;
}

let worker: Worker | undefined;
let requestCounter = 0;

const createWorker = (): Worker =>
    new Worker(
        new URL("../workers/relative-sort.worker.ts", import.meta.url),
    );

/**
 * Greedy CLIP snake in a worker so the gallery thread can keep painting.
 *
 * Transfers {@link packed}; the caller must not reuse that buffer.
 */
export const sortRelativeIdsInWorker = (
    ids: readonly number[],
    packed: Float32Array,
    mode: RelativePackedMode,
    seed: number,
    startFileId?: number,
    dim: number = KIT_EMBEDDING_DIMS,
): Promise<number[]> =>
    new Promise((resolve, reject) => {
        if (typeof Worker === "undefined") {
            reject(new Error("Workers are not available"));
            return;
        }
        if (!worker) {
            worker = createWorker();
        }
        const requestId = ++requestCounter;
        const idBuffer = Int32Array.from(ids);
        const handleMessage = (
            event: MessageEvent<RelativeSortWorkerResponse>,
        ): void => {
            if (event.data.requestId !== requestId) {
                return;
            }
            worker?.removeEventListener("message", handleMessage);
            if (event.data.error || !event.data.orderIds) {
                reject(new Error(event.data.error ?? "Relative sort failed"));
                return;
            }
            resolve([...event.data.orderIds]);
        };
        worker.addEventListener("message", handleMessage);
        const request: RelativeSortWorkerRequest = {
            requestId,
            mode,
            seed,
            startFileId,
            ids: idBuffer,
            packed,
            dim,
        };
        worker.postMessage(request, [idBuffer.buffer, packed.buffer]);
    });
