import { RemoteEnteFile } from "ente-media/file";
import { z } from "zod";
import type { HttpClient } from "../api/http";

const ObjectUploadURL = z.object({
    objectKey: z.string(),
    url: z.string(),
});

export type ObjectUploadURL = z.infer<typeof ObjectUploadURL>;

const ObjectUploadURLResponse = z.object({
    urls: ObjectUploadURL.array(),
});

export interface UploadedFileObjectAttributes {
    objectKey: string;
    decryptionHeader: string;
    size: number;
}

export interface PostEnteFileRequest {
    collectionID: number;
    encryptedKey: string;
    keyDecryptionNonce: string;
    file: UploadedFileObjectAttributes;
    thumbnail: UploadedFileObjectAttributes;
    metadata: { encryptedData: string; decryptionHeader: string };
    pubMagicMetadata?: {
        version: number;
        count: number;
        data: string;
        header: string;
    };
}

/**
 * Fetch pre-signed URLs for uploading multiple objects.
 */
export const fetchUploadURLs = async (
    http: HttpClient,
    countHint: number,
): Promise<ObjectUploadURL[]> => {
    const count = Math.min(50, countHint * 2);
    const response = await http.authFetchJSON<{ urls: ObjectUploadURL[] }>(
        "/files/upload-urls",
        { count, ts: Date.now() },
    );
    const parsed = ObjectUploadURLResponse.parse(response);
    return parsed.urls;
};

/**
 * Fetch a pre-signed URL for uploading one object.
 */
export const fetchUploadURL = async (
    http: HttpClient,
): Promise<ObjectUploadURL> => {
    const urls = await fetchUploadURLs(http, 1);
    const url = urls[0];
    if (!url) {
        throw new Error("Failed to obtain upload URL");
    }
    return url;
};

/**
 * Upload encrypted bytes to a pre-signed S3 URL.
 */
export const putFile = async (
    http: HttpClient,
    uploadURL: string,
    fileData: Uint8Array<ArrayBuffer>,
): Promise<void> => {
    const res = await fetch(uploadURL, {
        method: "PUT",
        headers: http.publicHeaders(),
        body: fileData,
    });
    http.ensureOk(res);
};

/**
 * Create a new file record on remote after objects are uploaded.
 */
export const postEnteFile = async (
    http: HttpClient,
    request: PostEnteFileRequest,
): Promise<RemoteEnteFile> => {
    const res = await http.authFetch("/files", undefined, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
    });
    return RemoteEnteFile.parse(await res.json());
};
