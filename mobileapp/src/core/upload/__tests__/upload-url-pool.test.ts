import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "@/core/api/http";
import {
    beginUploadBatch,
    endUploadBatch,
    takeUploadURL,
} from "@/core/upload/upload-url-pool";

const http = {} as HttpClient;

const mockFetchUploadURLs = vi.fn();

vi.mock("@/core/upload/remote", () => ({
    fetchUploadURLs: (...args: unknown[]) => mockFetchUploadURLs(...args),
    fetchUploadURL: vi.fn(),
}));

afterEach(() => {
    endUploadBatch();
    mockFetchUploadURLs.mockReset();
});

describe("upload URL pool", () => {
    it("prefetches and reuses batch URLs", async () => {
        mockFetchUploadURLs
            .mockResolvedValueOnce([
                { objectKey: "a", url: "https://upload/a" },
                { objectKey: "b", url: "https://upload/b" },
            ])
            .mockResolvedValueOnce([
                { objectKey: "c", url: "https://upload/c" },
            ]);

        await beginUploadBatch(http, 2);

        await expect(takeUploadURL(http)).resolves.toEqual({
            objectKey: "b",
            url: "https://upload/b",
        });
        await expect(takeUploadURL(http)).resolves.toEqual({
            objectKey: "a",
            url: "https://upload/a",
        });
        await expect(takeUploadURL(http)).resolves.toEqual({
            objectKey: "c",
            url: "https://upload/c",
        });

        expect(mockFetchUploadURLs).toHaveBeenCalledWith(http, 2);
        expect(mockFetchUploadURLs).toHaveBeenLastCalledWith(http, 2);
    });
});
