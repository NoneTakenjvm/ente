import type {
    BorderScanWorkerRequest,
    BorderScanWorkerResponse,
} from "@/workers/border-scan-worker-types";

/** Recreate the worker this often so mobile Chrome can reclaim decode heap. */
const RECYCLE_EVERY = 80;

let worker: Worker | undefined;
let processedSinceRecycle = 0;
let requestCounter = 0;

const createWorker = (): Worker =>
    new Worker(new URL("../workers/border-scan.worker.ts", import.meta.url));

const getWorker = (): Worker => {
    if (!worker) {
        worker = createWorker();
        processedSinceRecycle = 0;
    }
    return worker;
};

/**
 * Tear down the border-scan worker (call on panel unmount / cancel).
 */
export const terminateBorderScanWorker = (): void => {
    worker?.terminate();
    worker = undefined;
    processedSinceRecycle = 0;
};

const maybeRecycleWorker = (): void => {
    processedSinceRecycle += 1;
    if (processedSinceRecycle < RECYCLE_EVERY) {
        return;
    }
    terminateBorderScanWorker();
};

/**
 * Decode a thumbnail in a short-lived worker and return whether it looks
 * letterboxed. Transfers {@link bytes} (caller must not reuse the buffer).
 */
export const thumbHasBorderInWorker = (
    fileId: number,
    bytes: Uint8Array,
): Promise<boolean> =>
    new Promise((resolve, reject) => {
        const borderWorker = getWorker();
        const requestId = ++requestCounter;
        const handleMessage = (
            event: MessageEvent<BorderScanWorkerResponse>,
        ): void => {
            if (event.data.id !== requestId) {
                return;
            }
            borderWorker.removeEventListener("message", handleMessage);
            maybeRecycleWorker();
            if (event.data.error) {
                reject(new Error(event.data.error));
                return;
            }
            resolve(Boolean(event.data.hasBorder));
        };
        borderWorker.addEventListener("message", handleMessage);
        const transferable = bytes.byteOffset === 0 &&
                bytes.byteLength === bytes.buffer.byteLength ?
            bytes :
            bytes.slice();
        const request: BorderScanWorkerRequest = {
            id: requestId,
            fileId,
            bytes: transferable,
        };
        borderWorker.postMessage(request, [transferable.buffer]);
    });
