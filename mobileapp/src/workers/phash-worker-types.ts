import type { PhashEntry } from "@/lib/crop-match";
import type {
    Stage1FileEdge,
    Stage1Item,
    Stage1ProgressUpdate,
} from "@/lib/similarity-stage1-core";

/** Original-image facts the quality score needs besides the thumbnail pixels. */
export interface QualityScoreInputs {
    originalWidth: number;
    originalHeight: number;
    fileBytes: number;
}

/**
 * Decode one thumbnail once and compute only what the caller is missing:
 * the phash entry (`needsPhash`) and/or the quality score (`quality` present).
 */
export interface AnalyzeThumbnailRequest {
    kind: "analyze-thumbnail";
    id: number;
    fileId: number;
    bytes: Uint8Array;
    needsPhash: boolean;
    quality?: QualityScoreInputs;
}

export interface AnalyzeThumbnailResponse {
    id: number;
    fileId: number;
    phashEntry?: PhashEntry;
    qualityScore?: number;
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
    AnalyzeThumbnailRequest |
    CropCheckBatchMessage |
    Stage1Message |
    Stage1AbortMessage;

export type PhashWorkerOutbound =
    AnalyzeThumbnailResponse |
    CropCheckBatchResult |
    Stage1ProgressMessage |
    Stage1ResultMessage;
