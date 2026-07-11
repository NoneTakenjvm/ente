import { describe, expect, it } from "vitest";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import { mediaKindForFile, mimeTypeForFile } from "@/lib/media-kind";
import { toRenderableImageBlob } from "@/lib/renderable-image";

const fileWithName = (
    fileType: EnteFile["metadata"]["fileType"],
    title: string,
): EnteFile =>
    ({
        id: 1,
        metadata: { fileType, title },
    }) as EnteFile;

describe("mediaKindForFile", () => {
    it("treats live photos as images", () => {
        expect(
            mediaKindForFile(fileWithName(FileType.livePhoto, "shot.heic")),
        ).toBe("image");
    });
});

describe("mimeTypeForFile", () => {
    it("uses the file extension for still images", () => {
        expect(mimeTypeForFile(fileWithName(FileType.image, "a.png"))).toBe(
            "image/png",
        );
        expect(mimeTypeForFile(fileWithName(FileType.image, "a.heic"))).toBe(
            "image/heic",
        );
        expect(mimeTypeForFile(fileWithName(FileType.image, "a.webp"))).toBe(
            "image/webp",
        );
    });
});

describe("toRenderableImageBlob", () => {
    it("passes through JPEG bytes with an image/jpeg type", async () => {
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
        const blob = await toRenderableImageBlob(
            fileWithName(FileType.image, "photo.jpg"),
            jpeg,
        );
        expect(blob.type).toBe("image/jpeg");
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(jpeg);
    });
});
