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

/** Embed one text prompt with the CLIP text tower (loaded lazily). */
export type ClipEmbeddingEmbedTextMessage = {
    kind: "embed-text";
    id: number;
    text: string;
};

export type ClipEmbeddingInbound =
    ClipEmbeddingInitMessage |
    ClipEmbeddingEmbedBatchMessage |
    ClipEmbeddingEmbedTextMessage;

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

export type ClipEmbeddingEmbedTextDoneMessage = {
    kind: "embed-text-done";
    id: number;
    /** L2-normalised text embedding; absent when `error` is set. */
    vector?: Float32Array;
    error?: string;
};

export type ClipEmbeddingOutbound =
    ClipEmbeddingInitDoneMessage |
    ClipEmbeddingEmbedBatchDoneMessage |
    ClipEmbeddingEmbedTextDoneMessage;
