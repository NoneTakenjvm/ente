import type { PhashEntry } from "@/lib/crop-match";

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
