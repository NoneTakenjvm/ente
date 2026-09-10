import { describe, expect, it, vi } from "vitest";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";

vi.mock("@/lib/transcode/webcodecs-h264", async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        encodeH264WebCodecs: vi.fn(async () => {
            throw new Error("WebCodecs VideoEncoder unavailable");
        }),
    };
});

vi.mock("@/lib/ffmpeg", () => ({
    runFFmpeg: vi.fn(async () => new Uint8Array([0, 1, 2, 3])),
}));

import { encodeH264WebCodecs } from "@/lib/transcode/webcodecs-h264";
import { runFFmpeg } from "@/lib/ffmpeg";
import { compressMediaBytes } from "@/lib/transcode/compress-media";

const videoFile = (title = "clip.mov"): EnteFile =>
    ({
        id: 1,
        collectionID: 1,
        key: "key",
        metadata: {
            fileType: FileType.video,
            title,
            creationTime: 1,
            modificationTime: 1,
            duration: 4,
        },
        pubMagicMetadata: {
            version: 1,
            count: 1,
            data: { w: 1920, h: 1080 },
        },
    }) as unknown as EnteFile;

describe("compressMediaBytes video", () => {
    it("falls back to ffmpeg when WebCodecs is unavailable", async () => {
        const result = await compressMediaBytes(
            videoFile(),
            new Uint8Array([9, 8, 7]),
            { videoCrf: 28 },
        );

        expect(encodeH264WebCodecs).toHaveBeenCalledOnce();
        expect(runFFmpeg).toHaveBeenCalledOnce();
        expect(result.mimeType).toBe("video/mp4");
        expect(result.extension).toBe("mp4");
        expect(result.bytes).toEqual(new Uint8Array([0, 1, 2, 3]));
        expect(result.width).toBe(1920);
        expect(result.height).toBe(1080);
    });
});
