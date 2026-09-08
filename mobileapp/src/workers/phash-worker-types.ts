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
 * A crop-verification request sent to the worker pool. The luminance grids and
 * color signatures (already computed in the hash phase) are decoded and
 * template-matched entirely inside the worker, so the UI thread never blocks.
 */
export interface CropCheckMessage {
    kind: "crop-check";
    id: number;
    aColor: string;
    aGrid: string;
    bColor: string;
    bGrid: string;
}

export interface CropCheckResult {
    kind: "crop-check";
    id: number;
    /** True when the two images could be the same photo under a crop. */
    match: boolean;
    error?: string;
}

/**
 * Batched crop checks: unique grids are decoded once, then each pair is verified.
 * Prefer this over repeated {@link CropCheckMessage} for Stage-2.
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
     * Optional CLIP vectors keyed by file id string. When present, Stage-1
     * uses CLIP nearest-neighbour propose + mutual/tight confirm (edge
     * distance = round(cosine * 100)). Without CLIP, dHash Hamming is used.
     */
    embeddingsByFileId?: Record<string, number[]>;
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
    CropCheckMessage |
    CropCheckBatchMessage |
    Stage1Message |
    Stage1AbortMessage;

export type PhashWorkerOutbound =
    PhashWorkerResponse |
    CropCheckResult |
    CropCheckBatchResult |
    Stage1ProgressMessage |
    Stage1ResultMessage;
