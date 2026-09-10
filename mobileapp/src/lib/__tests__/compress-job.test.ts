import { describe, expect, it, vi } from "vitest";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import { CompressionSkippedError } from "@/lib/compress";
import { runCompressJob } from "@/lib/compress-job";

const stubFile = (id: number): EnteFile =>
    ({
        id,
        collectionID: 1,
        key: "key",
        metadata: {
            fileType: FileType.image,
            title: `${id}.jpg`,
            creationTime: 1,
            modificationTime: 1,
        },
    }) as unknown as EnteFile;

describe("runCompressJob", () => {
    it("counts skipped files separately from failures", async () => {
        const compressFile = vi.fn(async (fileId: number) => {
            if (fileId === 2) {
                throw new CompressionSkippedError();
            }
        });
        const stages: string[] = [];

        const result = await runCompressJob({
            files: [stubFile(1), stubFile(2), stubFile(3)],
            fileIds: new Set([1, 2, 3]),
            quality: 0.85,
            videoCrf: 28,
            signal: new AbortController().signal,
            shouldPause: () => false,
            onProgress: (update) => {
                stages.push(update.stage);
            },
            compressFile,
        });

        expect(result.completed).toBe(2);
        expect(result.skipped).toBe(1);
        expect(result.failed).toBe(0);
        expect(stages).toContain("skip");
        expect(stages).toContain("done");
    });
});
