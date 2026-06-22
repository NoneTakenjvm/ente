export interface PhashWorkerRequest {
    id: number;
    fileId: number;
    bytes: Uint8Array;
}

export interface PhashWorkerResponse {
    id: number;
    fileId: number;
    hash?: string;
    error?: string;
}
