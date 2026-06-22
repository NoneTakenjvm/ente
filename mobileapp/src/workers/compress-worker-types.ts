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
}

export interface CompressWorkerResponse {
    id: number;
    bytes?: Uint8Array;
    width?: number;
    height?: number;
    error?: string;
}
