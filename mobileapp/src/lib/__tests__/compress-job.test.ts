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
        info: { fileSize: 1024 },
        metadata: {
            fileType: FileType.image,
            title: `${id}.jpg`,
            creationTime: 1,
            modificationTime: 1,
        },
    }) as unknown as EnteFile;

const jobOptions = {
    files: [stubFile(1), stubFile(2), stubFile(3)],
    fileIds: new Set([1, 2, 3]),
    quality: 0.85,
    videoCrf: 28,
    signal: new AbortController().signal,
    shouldPause: () => false,
};

describe("runCompressJob", () => {
    it("counts skipped and failed uploads separately", async () => {
        const stages: string[] = [];

        const result = await runCompressJob({
            ...jobOptions,
            onProgress: (update) => {
                stages.push(update.stage);
            },
            downloadFile: vi.fn(async () => new Uint8Array([1])),
            compressFile: vi.fn(async (fileId: number) => {
                if (fileId === 2) {
                    throw new CompressionSkippedError();
                }
                return {
                    finalize: fileId === 3 ?
                        Promise.reject(new Error("upload failed")) :
                        Promise.resolve(),
                };
            }),
        });

        expect(result.completed).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.errors).toEqual(["3: upload failed"]);
        expect(stages).toContain("skip");
        expect(stages).toContain("error");
    });

    it("downloads the next file while the current one compresses", async () => {
        const events: string[] = [];

        await runCompressJob({
            ...jobOptions,
            onProgress: () => undefined,
            downloadFile: vi.fn(async (file: EnteFile) => {
                events.push(`download ${file.id}`);
                return new Uint8Array([1]);
            }),
            compressFile: vi.fn(async (fileId: number) => {
                await Promise.resolve();
                events.push(`compressed ${fileId}`);
                return { finalize: Promise.resolve() };
            }),
        });

        expect(events.indexOf("download 2")).toBeLessThan(
            events.indexOf("compressed 1"),
        );
    });

    it("stops without a failure when aborted during compression", async () => {
        const controller = new AbortController();
        const compressFile = vi.fn(async () => {
            controller.abort();
            throw new Error("aborted");
        });

        const result = await runCompressJob({
            ...jobOptions,
            signal: controller.signal,
            onProgress: () => undefined,
            downloadFile: vi.fn(async () => new Uint8Array([1])),
            compressFile,
        });

        expect(compressFile).toHaveBeenCalledOnce();
        expect(result.failed).toBe(0);
        expect(result.completed).toBe(0);
    });
});
