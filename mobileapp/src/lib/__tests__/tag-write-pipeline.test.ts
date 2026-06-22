import { describe, expect, it, vi, beforeEach } from "vitest";
import type { EnteFile } from "ente-media/file";
import { fileWithOrganizerTags } from "@/lib/tag-writes";

const { updateFileTags, refetchFile } = vi.hoisted(() => ({
    updateFileTags: vi.fn(),
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
}));

vi.mock("@/core/api/files", () => ({
    refetchFile,
}));

const stubFile = (id: number, tags: string[]): EnteFile =>
    fileWithOrganizerTags({ id } as EnteFile, tags);

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
