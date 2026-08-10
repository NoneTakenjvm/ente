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
