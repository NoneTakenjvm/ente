import { describe, expect, it } from "vitest";
import {
    isImageFile,
    isUploadableLocalFile,
    isVideoFile,
    sanitizeUploadImageTitle,
    sanitizeUploadVideoTitle,
} from "@/lib/local-media";

const fileLike = (name: string, type: string): File =>
    new File([new Uint8Array([1])], name, { type });

describe("local-media", () => {
    it("detects videos by mime type and extension", () => {
        expect(isVideoFile(fileLike("clip.mp4", "video/mp4"))).toBe(true);
        expect(isVideoFile(fileLike("clip.MOV", ""))).toBe(true);
        expect(isVideoFile(fileLike("clip.webm", "video/webm"))).toBe(true);
        expect(isVideoFile(fileLike("photo.jpg", "image/jpeg"))).toBe(false);
    });

    it("detects images by mime type and extension", () => {
        expect(isImageFile(fileLike("photo.jpg", "image/jpeg"))).toBe(true);
        expect(isImageFile(fileLike("photo.heic", ""))).toBe(true);
        expect(isImageFile(fileLike("clip.mp4", "video/mp4"))).toBe(false);
    });

    it("accepts photos and videos for upload staging", () => {
        expect(isUploadableLocalFile(fileLike("a.jpg", "image/jpeg"))).toBe(true);
        expect(isUploadableLocalFile(fileLike("b.mov", "video/quicktime"))).toBe(
            true,
        );
        expect(isUploadableLocalFile(fileLike("notes.txt", "text/plain"))).toBe(
            false,
        );
    });

    it("normalizes upload titles to jpg or mp4", () => {
        expect(sanitizeUploadImageTitle("vacation.PNG")).toBe("vacation.jpg");
        expect(sanitizeUploadVideoTitle("vacation.mov")).toBe("vacation.mp4");
        expect(sanitizeUploadVideoTitle("already.mp4")).toBe("already.mp4");
    });
});
