export interface CropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

type CompressWorkerOutput = "jpeg" | "auto";

export interface CompressWorkerRequest {
    id: number;
    bytes: Uint8Array;
    quality: number;
    cropRect?: CropRect;
    /** Crop in 0-1 units of the decoded image; resolved against its size in the worker. */
    normalizedCropRect?: CropRect;
    /** JPEG only: try lower mozjpeg qualities until output is smaller than input. */
    preferSmaller?: boolean;
    /** jpeg = crop path; auto = PhotoHoard classify + AVIF/WebP. */
    output?: CompressWorkerOutput;
    minSizeBytes?: number;
}

export interface CompressWorkerResponse {
    id: number;
    bytes?: Uint8Array;
    width?: number;
    height?: number;
    error?: string;
    encodeQuality?: number;
    encoder?: string;
    mimeType?: string;
    extension?: string;
    skipped?: boolean;
}
