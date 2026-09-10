/** Messages between the main thread and the CLIP embedding worker. */

export type ClipEmbeddingDevice = "webgpu" | "wasm";

export type ClipEmbeddingDtype = "fp16" | "fp32" | "q8";

/** How the last ORT forward was issued. */
export type ClipEmbeddingBatchMode = "batched" | "sequential";

export type ClipEmbeddingInitMessage = {
    kind: "init";
    id: number;
};

export type ClipEmbeddingEmbedMessage = {
    kind: "embed";
    id: number;
    fileId: number;
    /** JPEG thumbnail bytes (transferred). */
    bytes: Uint8Array;
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

/** Embed every {@link kitTileGrid} tile of one thumbnail as a single ORT batch. */
export type ClipEmbeddingEmbedTilesMessage = {
    kind: "embed-tiles";
    id: number;
    fileId: number;
    /** JPEG thumbnail bytes (transferred). */
    bytes: Uint8Array;
};

export type ClipEmbeddingInbound =
    ClipEmbeddingInitMessage |
    ClipEmbeddingEmbedMessage |
    ClipEmbeddingEmbedBatchMessage |
    ClipEmbeddingEmbedTilesMessage;

export type ClipEmbeddingInitDoneMessage = {
    kind: "init-done";
    id: number;
    device: ClipEmbeddingDevice;
    /** Weight dtype actually loaded. */
    dtype?: ClipEmbeddingDtype;
    /** Hugging Face model id. */
    modelId?: string;
    /** Set when WebGPU was skipped or failed before WASM fallback. */
    webGpuSkipReason?: string;
    /** Model failed to load on every backend. */
    error?: string;
};

export type ClipEmbeddingEmbedDoneMessage = {
    kind: "embed-done";
    id: number;
    fileId: number;
    /** L2-normalized 512-d vector, or omitted on decode/model failure. */
    vector?: number[];
    error?: string;
};

export type ClipEmbeddingEmbedBatchDoneMessage = {
    kind: "embed-batch-done";
    id: number;
    /** Parallel to request items — undefined vector means that image failed. */
    results: Array<{ fileId: number; vector?: number[] }>;
    batchMode?: ClipEmbeddingBatchMode;
    /** Set the first time a true batch forward failed and we serialised. */
    batchFallbackReason?: string;
    error?: string;
};

export type ClipEmbeddingEmbedTilesDoneMessage = {
    kind: "embed-tiles-done";
    id: number;
    fileId: number;
    rows: number;
    columns: number;
    /** Row-major L2-normalised tile vectors, `rows × columns × 512` (transferred). */
    vectors?: Float32Array;
    /** Worker-side cost split, for scan tuning. */
    timing?: ClipEmbeddingTileTiming;
    error?: string;
};

export type ClipEmbeddingTileTiming = {
    /** JPEG decode + tile crop/resize + tensor packing. */
    preprocessMs: number;
    /** ORT forward only (queue wait excluded). */
    forwardMs: number;
};

export type ClipEmbeddingOutbound =
    ClipEmbeddingInitDoneMessage |
    ClipEmbeddingEmbedDoneMessage |
    ClipEmbeddingEmbedBatchDoneMessage |
    ClipEmbeddingEmbedTilesDoneMessage;
