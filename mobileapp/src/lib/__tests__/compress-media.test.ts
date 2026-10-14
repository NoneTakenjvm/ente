import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";

vi.mock("@/lib/transcode/webcodecs-h264", async () => {
    const actual = await vi.importActual("@/lib/transcode/webcodecs-h264") as Record<
        string,
        unknown
    >;
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
    beforeEach(() => {
        vi.mocked(encodeH264WebCodecs).mockReset();
        vi.mocked(runFFmpeg).mockReset();
        vi.mocked(encodeH264WebCodecs).mockRejectedValue(
            new Error("WebCodecs VideoEncoder unavailable"),
        );
        vi.mocked(runFFmpeg).mockResolvedValue(new Uint8Array([0, 1, 2, 3]));
    });

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
        expect(result.encoder).toBe("ffmpeg");
    });

    it("caps both width and height in the ffmpeg scale filter", async () => {
        await compressMediaBytes(videoFile(), new Uint8Array([9, 8, 7]), {
            videoCrf: 28,
            maxLongEdge: 1920,
        });

        const args = vi.mocked(runFFmpeg).mock.calls[0]![0];
        const filter = args[args.indexOf("-vf") + 1];
        expect(filter).toContain("min(1920,iw)");
        expect(filter).toContain("min(1920,ih)");
        expect(filter).toContain("force_original_aspect_ratio=decrease");
    });

    it("does not start ffmpeg once the signal is aborted", async () => {
        const controller = new AbortController();
        vi.mocked(encodeH264WebCodecs).mockImplementationOnce(async () => {
            controller.abort();
            throw new Error("WebCodecs VideoEncoder unavailable");
        });

        await expect(
            compressMediaBytes(videoFile(), new Uint8Array([9, 8, 7]), {
                videoCrf: 28,
                signal: controller.signal,
            }),
        ).rejects.toThrow();
        expect(runFFmpeg).not.toHaveBeenCalled();
    });

    it("uses the WebCodecs output with audio and skips ffmpeg", async () => {
        vi.mocked(encodeH264WebCodecs).mockResolvedValueOnce({
            bytes: new Uint8Array([1, 2, 3]),
            width: 640,
            height: 360,
            duration: 2,
            hasAudio: true,
        });

        const result = await compressMediaBytes(
            videoFile(),
            new Uint8Array([9, 8, 7]),
            { videoCrf: 28 },
        );

        expect(runFFmpeg).not.toHaveBeenCalled();
        expect(result.encoder).toBe("webcodecs");
        expect(result.audio).toBe("kept");
        expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]));
    });
});
