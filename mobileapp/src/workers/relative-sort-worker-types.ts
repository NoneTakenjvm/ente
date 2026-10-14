import type { RelativePackedMode } from "@/lib/relative-sort-packed";

export interface RelativeSortWorkerRequest {
    id: number;
    mode: RelativePackedMode;
    seed: number;
    startFileId?: number;
    /**
     * File ids as Float64 — Ente ids exceed Int32 range; Int32 truncation made
     * the worker return ids that never matched the gallery (identity order).
     */
    ids: Float64Array;
    packed: Float32Array;
    dim: number;
}

export interface RelativeSortWorkerResponse {
    id: number;
    orderIds?: Float64Array;
    error?: string;
}
