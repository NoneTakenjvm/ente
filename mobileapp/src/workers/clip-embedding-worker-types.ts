/** Messages between the main thread and the CLIP embedding worker. */

export type ClipEmbeddingDevice = "webgpu" | "wasm";

export type ClipEmbeddingDtype = "fp32";

/** How the last ORT forward was issued. */
export type ClipEmbeddingBatchMode = "batched" | "sequential";

type ClipEmbeddingInitMessage = {
    kind: "init";
    id: number;
};

/** One ORT forward with multiple images (true GPU batch when supported). */
export type ClipEmbeddingEmbedBatchMessage = {
    kind: "embed-batch";
    id: number;
    items: Array<{
        fileId: number;
        bytes: Uint8Array;
    }>;
};

export type ClipEmbeddingInbound =
    ClipEmbeddingInitMessage |
    ClipEmbeddingEmbedBatchMessage;

export type ClipEmbeddingInitDoneMessage = {
    kind: "init-done";
    id: number;
    device: ClipEmbeddingDevice;
    /** Weight dtype actually loaded. */
    dtype?: ClipEmbeddingDtype;
    /** Set when WebGPU was skipped or failed before WASM fallback. */
    webGpuSkipReason?: string;
    /** Model failed to load on every backend. */
    error?: string;
};

export type ClipEmbeddingEmbedBatchDoneMessage = {
    kind: "embed-batch-done";
    id: number;
    /** Parallel to request items — undefined vector means that image failed. */
    results: Array<{ fileId: number; vector?: Float32Array }>;
    batchMode?: ClipEmbeddingBatchMode;
    /** Set the first time a true batch forward failed and we serialised. */
    batchFallbackReason?: string;
    error?: string;
};

export type ClipEmbeddingOutbound =
    ClipEmbeddingInitDoneMessage |
    ClipEmbeddingEmbedBatchDoneMessage;
