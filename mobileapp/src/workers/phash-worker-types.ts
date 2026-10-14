import type {
    Stage1FileEdge,
    Stage1Item,
    Stage1ProgressUpdate,
} from "@/lib/similarity-stage1-core";

export interface PhashWorkerRequest {
    kind: "hash";
    id: number;
    fileId: number;
    bytes: Uint8Array;
}

export interface PhashWorkerResponse {
    id: number;
    fileId: number;
    /** The 8 rotation/mirror-variant dHash hex strings for the image (stage 1). */
    hashes?: string[];
    /** 64-bit color-palette signature (hex) used as the crop candidate gate. */
    color?: string;
    /** Base64 48x48 luminance grid used for crop template-match verification. */
    grid?: string;
    error?: string;
}

/**
 * Batched crop checks: unique grids are decoded once, then each pair is verified.
 */
export interface CropCheckBatchMessage {
    kind: "crop-check-batch";
    id: number;
    /** Opaque key → color + base64 grid for each unique file in this batch. */
    entries: Record<string, { color: string; grid: string }>;
    /** Ordered pairs of entry keys; result `matches[i]` corresponds to `pairs[i]`. */
    pairs: Array<[string, string]>;
}

export interface CropCheckBatchResult {
    kind: "crop-check-batch";
    id: number;
    matches: boolean[];
    error?: string;
}

/** Stage-1 clustering request — runs entirely off the UI thread. */
export interface Stage1Message {
    kind: "stage1";
    id: number;
    items: Stage1Item[];
    threshold: number;
    /**
     * Optional packed L2-normalized CLIP vectors (row i belongs to fileIds[i]),
     * transferred rather than copied. When present, Stage-1 uses CLIP
     * nearest-neighbour propose + mutual/tight confirm; without, dHash Hamming.
     */
    embeddings?: { vectors: Float32Array; fileIds: Float64Array; dims: number };
}

export interface Stage1AbortMessage {
    kind: "stage1-abort";
    id: number;
}

export interface Stage1ProgressMessage {
    kind: "stage1-progress";
    id: number;
    update: Stage1ProgressUpdate;
}

export interface Stage1ResultMessage {
    kind: "stage1-result";
    id: number;
    clusters?: Stage1ProgressUpdate["clusters"];
    edges?: Stage1FileEdge[];
    error?: string;
}

export type PhashWorkerInbound =
    PhashWorkerRequest |
    CropCheckBatchMessage |
    Stage1Message |
    Stage1AbortMessage;

export type PhashWorkerOutbound =
    PhashWorkerResponse |
    CropCheckBatchResult |
    Stage1ProgressMessage |
    Stage1ResultMessage;
