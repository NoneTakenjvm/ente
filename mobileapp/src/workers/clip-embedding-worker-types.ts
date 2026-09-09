/** Messages between the main thread and the CLIP embedding worker. */

export type ClipEmbeddingDevice = "webgpu" | "wasm";

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

export type ClipEmbeddingInbound =
    ClipEmbeddingInitMessage |
    ClipEmbeddingEmbedMessage |
    ClipEmbeddingEmbedBatchMessage;

export type ClipEmbeddingInitDoneMessage = {
    kind: "init-done";
    id: number;
    device: ClipEmbeddingDevice;
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
    error?: string;
};

export type ClipEmbeddingOutbound =
    ClipEmbeddingInitDoneMessage |
    ClipEmbeddingEmbedDoneMessage |
    ClipEmbeddingEmbedBatchDoneMessage;
