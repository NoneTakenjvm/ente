/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VIDEO_CRF } from "@/lib/compress";
import { prepareLocalVideo } from "@/lib/transcode/prepare-local-video";

const { mockRunFFmpeg } = vi.hoisted(() => ({
    mockRunFFmpeg: vi.fn(),
}));

vi.mock("@/lib/ffmpeg", () => ({
    runFFmpeg: mockRunFFmpeg,
}));

const stubVideoProbe = (width: number, height: number, duration: number): void => {
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
        if (tag !== "video") {
            return originalCreateElement(tag);
        }
        const element = document.createElement.bind(document)("div");
        const video = element as unknown as HTMLVideoElement;
        Object.defineProperty(video, "videoWidth", { value: width });
        Object.defineProperty(video, "videoHeight", { value: height });
        Object.defineProperty(video, "duration", { value: duration });
        Object.defineProperty(video, "src", {
            set(): void {
                queueMicrotask(() => video.onloadedmetadata?.(new Event("loadedmetadata")));
            },
        });
        return video;
    });
};

afterEach(() => {
    vi.restoreAllMocks();
    mockRunFFmpeg.mockReset();
});

describe("prepareLocalVideo", () => {
    it("transcodes device video to mp4 and reads metadata", async () => {
        const transcoded = new Uint8Array([0, 1, 2, 3]);
        mockRunFFmpeg.mockResolvedValue(transcoded);
        stubVideoProbe(1280, 720, 14.6);

        const file = new File([new Uint8Array([9, 8, 7])], "clip.mov", {
            type: "video/quicktime",
        });

        const prepared = await prepareLocalVideo(file);

        expect(mockRunFFmpeg).toHaveBeenCalledWith(
            [
                "-i", "INPUT",
                "-c:v", "libx264",
                "-crf", String(DEFAULT_VIDEO_CRF),
                "-preset", "fast",
                "-c:a", "aac",
                "-movflags", "+faststart",
                "OUTPUT",
            ],
            expect.any(Blob),
            "mp4",
        );
        expect(prepared).toEqual({
            bytes: transcoded,
            width: 1280,
            height: 720,
            duration: 15,
        });
    });

    it("infers mime type from extension when the picker omits it", async () => {
        mockRunFFmpeg.mockResolvedValue(new Uint8Array([1]));
        stubVideoProbe(640, 480, 3);

        await prepareLocalVideo(new File([new Uint8Array([1])], "clip.webm", { type: "" }));

        const inputBlob = mockRunFFmpeg.mock.calls[0]![1] as Blob;
        expect(inputBlob.type).toBe("video/webm");
    });
});
