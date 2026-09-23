import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "@/core/api/http";
import {
    putEncryptedObject,
    takeUploadURL,
} from "@/core/upload/upload-url-pool";

const http = {} as HttpClient;

const mockFetchUploadURLWithMetadata = vi.fn();
const mockPutFile = vi.fn();
const mockComputeMd5 = vi.fn(() => "md5-b64");

vi.mock("@/core/upload/remote", () => ({
    fetchUploadURLWithMetadata: (...args: unknown[]) =>
        mockFetchUploadURLWithMetadata(...args),
    putFile: (...args: unknown[]) => mockPutFile(...args),
}));

vi.mock("@/core/upload/md5", () => ({
    computeMd5Base64: (...args: unknown[]) => mockComputeMd5(...args),
}));

afterEach(() => {
    mockFetchUploadURLWithMetadata.mockReset();
    mockPutFile.mockReset();
    mockComputeMd5.mockClear();
});

describe("checksum upload URLs", () => {
    it("mints a URL from encrypted bytes length + MD5", async () => {
        mockFetchUploadURLWithMetadata.mockResolvedValueOnce({
            objectKey: "a",
            url: "https://upload/a",
        });
        const bytes = new Uint8Array([1, 2, 3, 4]);

        await expect(takeUploadURL(http, bytes)).resolves.toEqual({
            upload: { objectKey: "a", url: "https://upload/a" },
            contentMd5: "md5-b64",
        });

        expect(mockComputeMd5).toHaveBeenCalledWith(bytes);
        expect(mockFetchUploadURLWithMetadata).toHaveBeenCalledWith(http, {
            contentLength: 4,
            contentMd5: "md5-b64",
        });
    });

    it("puts with Content-MD5 after minting", async () => {
        mockFetchUploadURLWithMetadata.mockResolvedValueOnce({
            objectKey: "b",
            url: "https://upload/b",
        });
        mockPutFile.mockResolvedValueOnce(undefined);
        const bytes = new Uint8Array([9, 8]) as Uint8Array<ArrayBuffer>;

        await expect(putEncryptedObject(http, bytes)).resolves.toEqual({
            objectKey: "b",
            url: "https://upload/b",
        });

        expect(mockPutFile).toHaveBeenCalledWith(http, "https://upload/b", bytes, {
            contentMd5: "md5-b64",
            onProgress: undefined,
        });
    });
});
