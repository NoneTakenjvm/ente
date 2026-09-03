import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import { filePixelArea } from "@/lib/file-aspect-ratio";
import { sortFilesByImageSize } from "@/lib/image-size-sort";

const fileWithDimensions = (id: number, width: number, height: number): EnteFile =>
    ({
        id,
        pubMagicMetadata: { data: { w: width, h: height } },
    }) as EnteFile;

describe("filePixelArea", () => {
    it("returns width times height", () => {
        expect(filePixelArea(fileWithDimensions(1, 4000, 3000))).toBe(12_000_000);
    });

    it("returns 0 when dimensions are missing", () => {
        expect(filePixelArea({ id: 2 } as EnteFile)).toBe(0);
    });
});

describe("sortFilesByImageSize", () => {
    const files = [
        fileWithDimensions(1, 100, 100), // 10k
        fileWithDimensions(2, 4000, 3000), // 12M
        fileWithDimensions(3, 800, 600), // 480k
        { id: 4 } as EnteFile, // unknown
    ];

    it("largest puts biggest area first and unknown last", () => {
        expect(
            sortFilesByImageSize(files, "largest").map((file) => file.id),
        ).toEqual([2, 3, 1, 4]);
    });

    it("smallest puts smallest area first and unknown first", () => {
        expect(
            sortFilesByImageSize(files, "smallest").map((file) => file.id),
        ).toEqual([4, 1, 3, 2]);
    });

    it("none returns a shallow copy in the same order", () => {
        const ordered = sortFilesByImageSize(files, "none");
        expect(ordered.map((file) => file.id)).toEqual([1, 2, 3, 4]);
        expect(ordered).not.toBe(files);
    });
});
