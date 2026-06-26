/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareLocalVideo } from "@/lib/transcode/prepare-local-video";

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
});

describe("prepareLocalVideo", () => {
    it("reads original bytes and metadata without transcoding", async () => {
        stubVideoProbe(1280, 720, 14.6);

        const sourceBytes = new Uint8Array([9, 8, 7]);
        const file = new File([sourceBytes], "clip.mov", {
            type: "video/quicktime",
        });

        const prepared = await prepareLocalVideo(file);

        expect(prepared).toEqual({
            bytes: sourceBytes,
            mimeType: "video/quicktime",
            width: 1280,
            height: 720,
            duration: 15,
        });
    });

    it("infers mime type from extension when the picker omits it", async () => {
        stubVideoProbe(640, 480, 3);

        const prepared = await prepareLocalVideo(
            new File([new Uint8Array([1])], "clip.webm", { type: "" }),
        );

        expect(prepared.mimeType).toBe("video/webm");
    });
});
