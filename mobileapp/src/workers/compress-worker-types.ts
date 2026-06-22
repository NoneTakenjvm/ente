export interface CropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface CompressWorkerRequest {
    id: number;
    bytes: Uint8Array;
    quality: number;
    cropRect?: CropRect;
    /** Try lower mozjpeg qualities until output is smaller than input. */
    preferSmaller?: boolean;
}

export interface CompressWorkerResponse {
    id: number;
    bytes?: Uint8Array;
    width?: number;
    height?: number;
    error?: string;
    /** mozjpeg quality used (0–100), for diagnostics. */
    encodeQuality?: number;
    encoder?: string;
}
