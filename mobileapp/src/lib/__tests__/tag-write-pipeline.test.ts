import { describe, expect, it, vi, beforeEach } from "vitest";
import type { EnteFile } from "ente-media/file";
import { fileWithOrganizerTags } from "@/lib/tag-writes";

const { updateFileTags, putFilesTags, refetchFile } = vi.hoisted(() => ({
    updateFileTags: vi.fn(),
    putFilesTags: vi.fn(),
    refetchFile: vi.fn(),
}));

vi.mock("@/core/metadata", () => ({
    MetadataUpdateError: class MetadataUpdateError extends Error {
        constructor(
            message: string,
            readonly status: number,
            readonly retryAfterMs?: number,
        ) {
            super(message);
            this.name = "MetadataUpdateError";
        }
    },
    getPublicMetadata: (file: EnteFile) => file.pubMagicMetadata?.data ?? {},
    updateFileTags,
    putFilesTags,
}));

vi.mock("@/core/api/files", () => ({
    refetchFile,
}));

const stubFile = (id: number, tags: string[]): EnteFile =>
    fileWithOrganizerTags({ id, key: `key-${id}` } as EnteFile, tags);

describe("writeAndVerifyTags", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns verified when refetched tags match intent", async () => {
        const { writeAndVerifyTags } = await import("@/lib/tag-write-pipeline");
        const file = stubFile(1, []);
        const verified = stubFile(1, ["new"]);

        updateFileTags.mockResolvedValue(undefined);
        refetchFile.mockResolvedValue(verified);

        const result = await writeAndVerifyTags(
            {} as never,
            file,
            "collection-key",
            ["new"],
        );

        expect(result.status).toBe("verified");
        expect(result.file).toBe(verified);
        expect(updateFileTags).toHaveBeenCalledTimes(1);
        expect(refetchFile).toHaveBeenCalledTimes(1);
    });

    it("retries once then returns pending when verification keeps failing", async () => {
        const { writeAndVerifyTags } = await import("@/lib/tag-write-pipeline");
        const file = stubFile(1, []);
        const stale = stubFile(1, []);

        updateFileTags.mockResolvedValue(undefined);
        refetchFile.mockResolvedValue(stale);

        const result = await writeAndVerifyTags(
            {} as never,
            file,
            "collection-key",
            ["new"],
        );

        expect(result.status).toBe("pending");
        expect(updateFileTags).toHaveBeenCalledTimes(2);
        expect(refetchFile).toHaveBeenCalledTimes(3);
    });
});

describe("writeAndVerifyTagsBatch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("PUTs all files in one batch and marks them verified", async () => {
        const { writeAndVerifyTagsBatch } = await import(
            "@/lib/tag-write-pipeline"
        );
        const files = [stubFile(1, []), stubFile(2, [])];
        const updated = [stubFile(1, ["a"]), stubFile(2, ["b"])];
        putFilesTags.mockResolvedValue(updated);

        const result = await writeAndVerifyTagsBatch(
            {} as never,
            [
                {
                    file: files[0]!,
                    collectionKey: "k",
                    intendedTags: ["a"],
                },
                {
                    file: files[1]!,
                    collectionKey: "k",
                    intendedTags: ["b"],
                },
            ],
        );

        expect(putFilesTags).toHaveBeenCalledTimes(1);
        expect(updateFileTags).not.toHaveBeenCalled();
        expect(result.verified).toHaveLength(2);
        expect(result.pending).toHaveLength(0);
    });

    it("falls back to per-file writes on batch version conflict", async () => {
        const { writeAndVerifyTagsBatch } = await import(
            "@/lib/tag-write-pipeline"
        );
        const { MetadataUpdateError } = await import("@/core/metadata");
        const file = stubFile(1, []);
        const verified = stubFile(1, ["a"]);

        putFilesTags.mockRejectedValue(
            new MetadataUpdateError("conflict", 409),
        );
        updateFileTags.mockResolvedValue(undefined);
        refetchFile.mockResolvedValue(verified);

        const result = await writeAndVerifyTagsBatch(
            {} as never,
            [
                {
                    file,
                    collectionKey: "k",
                    intendedTags: ["a"],
                },
            ],
        );

        expect(putFilesTags).toHaveBeenCalled();
        expect(updateFileTags).toHaveBeenCalled();
        expect(result.verified).toHaveLength(1);
        expect(result.pending).toHaveLength(0);
    });
});
