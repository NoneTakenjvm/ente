import { KIT_EMBEDDING_DIMS } from "@/lib/kit-embedding";
import type { RelativePackedMode } from "@/lib/relative-sort-packed";
import { createWorkerClient } from "@/lib/worker-client";
import type {
    RelativeSortWorkerRequest,
    RelativeSortWorkerResponse,
} from "@/workers/relative-sort-worker-types";

/** Release the sort worker after this long with no requests. */
const RELATIVE_SORT_IDLE_TERMINATE_MS = 30_000;

const sortWorker = createWorkerClient<
    RelativeSortWorkerRequest,
    RelativeSortWorkerResponse
>({
    createWorker: () =>
        new Worker(
            new URL("../workers/relative-sort.worker.ts", import.meta.url),
        ),
    idleMs: RELATIVE_SORT_IDLE_TERMINATE_MS,
});

/**
 * Greedy CLIP snake in a worker so the gallery thread can keep painting.
 *
 * Transfers {@link packed}; the caller must not reuse that buffer.
 */
export const sortRelativeIdsInWorker = async (
    ids: readonly number[],
    packed: Float32Array,
    mode: RelativePackedMode,
    seed: number,
    startFileId?: number,
    dim: number = KIT_EMBEDDING_DIMS,
): Promise<number[]> => {
    const idBuffer = Float64Array.from(ids);
    const response = await sortWorker.request(
        { mode, seed, startFileId, ids: idBuffer, packed, dim },
        [idBuffer.buffer, packed.buffer],
    );
    if (response.error || !response.orderIds) {
        throw new Error(response.error ?? "Relative sort failed");
    }
    return [...response.orderIds];
};
