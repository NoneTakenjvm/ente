export interface PhashWorkerRequest {
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
