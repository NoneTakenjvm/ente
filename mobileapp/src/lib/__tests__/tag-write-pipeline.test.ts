import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { EnteFile } from "ente-media/file";
import { HTTPError } from "ente-base/http";
import { fileWithOrganizerTags } from "@/lib/tag-writes";
import { writeAndVerifyTagsBatch } from "@/lib/tag-write-pipeline";

const { mergePublicMetadata, putFilesPublicMetadata } = vi.hoisted(() => ({
    mergePublicMetadata: vi.fn(),
    putFilesPublicMetadata: vi.fn(),
}));

vi.mock("@/core/metadata", () => ({
    getPublicMetadata: (file: EnteFile) => file.pubMagicMetadata?.data ?? {},
    pubMagicVersionForPut: (file: EnteFile) =>
        file.pubMagicMetadata?.version || undefined,
    mergePublicMetadata,
    putFilesPublicMetadata,
}));

const stubFile = (id: number, tags: string[]): EnteFile =>
    fileWithOrganizerTags({ id, key: `key-${id}` } as EnteFile, tags);

const httpError = (status: number): HTTPError =>
    new HTTPError({
        status,
        statusText: "",
        url: "https://api.example.test/files/public-magic-metadata",
        headers: new Headers(),
    } as Response);

const item = (file: EnteFile, intendedTags: string[]) => ({
    file,
    collectionKey: "k",
    intendedTags,
});

describe("writeAndVerifyTagsBatch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const run = async (items: ReturnType<typeof item>[]) => {
        const result = writeAndVerifyTagsBatch({} as never, items);
        await vi.runAllTimersAsync();
        return result;
    };

    it("PUTs all files in one batch and marks them verified", async () => {
        const updated = [stubFile(1, ["a"]), stubFile(2, ["b"])];
        putFilesPublicMetadata.mockResolvedValue(updated);

        const result = await run([
            item(stubFile(1, []), ["a"]),
            item(stubFile(2, []), ["b"]),
        ]);

        expect(putFilesPublicMetadata).toHaveBeenCalledTimes(1);
        expect(mergePublicMetadata).not.toHaveBeenCalled();
        expect(result.verified).toEqual(updated);
        expect(result.pending).toHaveLength(0);
    });

    it("retries a transient batch failure without falling back", async () => {
        putFilesPublicMetadata
            .mockRejectedValueOnce(httpError(503))
            .mockResolvedValueOnce([stubFile(1, ["a"])]);

        const result = await run([item(stubFile(1, []), ["a"])]);

        expect(putFilesPublicMetadata).toHaveBeenCalledTimes(2);
        expect(mergePublicMetadata).not.toHaveBeenCalled();
        expect(result.verified).toHaveLength(1);
    });

    it("marks the chunk pending when transient failures persist", async () => {
        putFilesPublicMetadata.mockRejectedValue(httpError(500));

        const result = await run([item(stubFile(1, []), ["a"])]);

        expect(putFilesPublicMetadata).toHaveBeenCalledTimes(3);
        expect(mergePublicMetadata).not.toHaveBeenCalled();
        expect(result.verified).toHaveLength(0);
        expect(result.pending).toHaveLength(1);
    });

    it("falls back to per-file writes on batch version conflict without retrying the batch", async () => {
        const file = stubFile(1, []);
        putFilesPublicMetadata.mockRejectedValue(httpError(409));
        mergePublicMetadata.mockResolvedValue(file);

        const result = await run([item(file, ["a"])]);

        expect(putFilesPublicMetadata).toHaveBeenCalledTimes(1);
        expect(mergePublicMetadata).toHaveBeenCalledTimes(1);
        expect(result.verified).toEqual([file]);
        expect(result.pending).toHaveLength(0);
    });

    it("marks a file pending when its per-file write fails", async () => {
        const file = stubFile(1, []);
        putFilesPublicMetadata.mockRejectedValue(httpError(409));
        mergePublicMetadata.mockRejectedValue(httpError(409));

        const result = await run([item(file, ["a"])]);

        expect(mergePublicMetadata).toHaveBeenCalledTimes(1);
        expect(result.verified).toHaveLength(0);
        expect(result.pending).toEqual([file]);
    });
});
