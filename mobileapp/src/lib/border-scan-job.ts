import { createWorkerClient } from "@/lib/worker-client";
import type {
    BorderScanWorkerRequest,
    BorderScanWorkerResponse,
} from "@/workers/border-scan-worker-types";

/** Recreate the worker this often so mobile Chrome can reclaim decode heap. */
const RECYCLE_EVERY = 80;

const borderWorker = createWorkerClient<
    BorderScanWorkerRequest,
    BorderScanWorkerResponse
>({
    createWorker: () =>
        new Worker(new URL("../workers/border-scan.worker.ts", import.meta.url)),
    recycleAfter: RECYCLE_EVERY,
});

/**
 * Tear down the border-scan worker (call on panel unmount / cancel).
 */
export const terminateBorderScanWorker = (): void => {
    borderWorker.terminate();
};

/**
 * Decode a thumbnail in a short-lived worker and return whether it looks
 * letterboxed. Transfers {@link bytes} (caller must not reuse the buffer).
 */
export const thumbHasBorderInWorker = async (
    fileId: number,
    bytes: Uint8Array,
): Promise<boolean> => {
    const transferable = bytes.byteOffset === 0 &&
            bytes.byteLength === bytes.buffer.byteLength ?
        bytes :
        bytes.slice();
    const response = await borderWorker.request({ fileId, bytes: transferable }, [
        transferable.buffer as ArrayBuffer,
    ]);
    if (response.error) {
        throw new Error(response.error);
    }
    return Boolean(response.hasBorder);
};
