import type { ClipPairs } from "@/lib/similarity-clip";

export interface SimilarPairsWorkerRequest {
    id: number;
    /** File ids as Float64 — Ente ids exceed Int32 range. */
    fileIds: Float64Array;
    /** L2-normalized CLIP vectors; row i belongs to `fileIds[i]`. */
    packed: Float32Array;
    dims: number;
    maxScore: number;
    /** Only the first `queryCount` rows are searched; each is compared with every other row. */
    queryCount: number;
}

export interface SimilarPairsWorkerResponse {
    id: number;
    /** True on progress replies; the final reply carries {@link pairs}. */
    partial?: boolean;
    completed?: number;
    total?: number;
    pairs?: ClipPairs;
    error?: string;
}
