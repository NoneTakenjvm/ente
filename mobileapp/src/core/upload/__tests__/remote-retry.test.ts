/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "@/core/api/http";
import {
    postEnteFile,
    putFile,
    type PostEnteFileRequest,
} from "@/core/upload/remote";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const http = {
    publicHeaders: (): Record<string, string> => ({}),
    ensureOk: (res: Response): void => {
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${res.url}`);
        }
    },
    // Mirror the real HttpClient.authFetch: resolve the pre-signed fetch, then
    // surface non-2xx as an `HTTP <status>` error so retries can key off it.
    authFetch: async (
        _path: string,
        _params?: Record<string, string>,
        _init?: RequestInit,
    ): Promise<Response> => {
        const res = await mockFetch(
            `https://api.ente.com${_path ?? ""}`,
            _init,
        );
        http.ensureOk(res);
        return res;
    },
} as unknown as HttpClient;

const remoteFilePayload = (id: number): Record<string, unknown> => ({
    id,
    collectionID: 7,
    ownerID: 1,
    updationTime: 1700000000000000,
    encryptedKey: "key",
    keyDecryptionNonce: "nonce",
    metadata: { encryptedData: "md", decryptionHeader: "hd" },
    pubMagicMetadata: {
        version: 1,
        count: 0,
        data: "data",
        header: "header",
    },
    file: {
        objectKey: "obj",
        decryptionHeader: "dh",
        size: 10,
    },
    thumbnail: {
        objectKey: "thumb",
        decryptionHeader: "tdh",
        size: 5,
    },
    isDeleted: false,
});

const postRequest: PostEnteFileRequest = {
    collectionID: 7,
    encryptedKey: "key",
    keyDecryptionNonce: "nonce",
    file: { objectKey: "obj", decryptionHeader: "dh", size: 10 },
    thumbnail: { objectKey: "thumb", decryptionHeader: "tdh", size: 5 },
    metadata: { encryptedData: "md", decryptionHeader: "hd" },
};

const response = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

afterEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
});

describe("withUploadRetry via putFile/postEnteFile", () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    it("retries putFile on HTTP 500 then succeeds", async () => {
        mockFetch
            .mockResolvedValueOnce(response(null, 500))
            .mockResolvedValueOnce(response(null, 500))
            .mockResolvedValueOnce(response(null, 200));

        const fileData = new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>;
        await putFile(http, "https://upload/obj", fileData);

        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(mockFetch.mock.calls[0]![0]).toBe("https://upload/obj");
        expect(mockFetch.mock.calls[0]![1]!.method).toBe("PUT");
    });

    it("does not retry a non-transient 4xx on putFile", async () => {
        mockFetch.mockResolvedValueOnce(response(null, 400));

        const fileData = new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>;
        await expect(putFile(http, "https://upload/obj", fileData)).rejects.toThrow(
            "HTTP 400",
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws after exhausting retries on persistent 500", async () => {
        mockFetch.mockResolvedValue(response(null, 500));

        const fileData = new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>;
        await expect(putFile(http, "https://upload/obj", fileData)).rejects.toThrow(
            "HTTP 500",
        );
        // 4 total attempts (1 + 3 retries) for putFile.
        expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("retries postEnteFile on 5xx then finalizes to a single file", async () => {
        mockFetch
            .mockResolvedValueOnce(response(null, 503))
            .mockResolvedValueOnce(response(remoteFilePayload(42), 200));

        const posted = await postEnteFile(http, postRequest);

        expect(mockFetch).toHaveBeenCalledTimes(2);
        // The request is replayed unchanged, so the server can dedupe by object key.
        expect(mockFetch.mock.calls[0]![1]!.body).toBe(
            mockFetch.mock.calls[1]![1]!.body,
        );
        expect(posted.id).toBe(42);
    });

    it("handles a network TypeError as retryable and succeeds after retries", async () => {
        mockFetch
            .mockRejectedValueOnce(new TypeError("Failed to fetch"))
            .mockResolvedValueOnce(response(null, 200));

        const fileData = new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>;
        await putFile(http, "https://upload/obj", fileData);
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});
