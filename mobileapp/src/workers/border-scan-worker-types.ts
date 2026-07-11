export interface BorderScanWorkerRequest {
    id: number;
    fileId: number;
    bytes: Uint8Array;
}

export interface BorderScanWorkerResponse {
    id: number;
    fileId: number;
    hasBorder?: boolean;
    error?: string;
}
