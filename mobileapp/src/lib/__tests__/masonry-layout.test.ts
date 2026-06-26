import { describe, expect, it } from "vitest";
import { fileAspectRatio } from "@/lib/file-aspect-ratio";
import { computeMasonryLayout } from "@/lib/masonry-layout";
import type { EnteFile } from "ente-media/file";

const fileWithDimensions = (id: number, w: number, h: number): EnteFile =>
    ({
        id,
        pubMagicMetadata: { data: { w, h } },
    }) as EnteFile;

describe("fileAspectRatio", () => {
    it("returns width divided by height when metadata is present", () => {
        expect(fileAspectRatio(fileWithDimensions(1, 400, 200))).toBe(2);
        expect(fileAspectRatio(fileWithDimensions(2, 200, 400))).toBe(0.5);
    });

    it("falls back to 1 when dimensions are missing", () => {
        expect(fileAspectRatio({ id: 3 } as EnteFile)).toBe(1);
    });
});

describe("computeMasonryLayout", () => {
    it("places portrait and landscape items in separate columns", () => {
        const files = [
            fileWithDimensions(1, 100, 200),
            fileWithDimensions(2, 200, 100),
        ];
        const layout = computeMasonryLayout(files, 320, 2);

        expect(layout.items).toHaveLength(2);
        expect(layout.items[0].y).toBe(0);
        expect(layout.items[1].y).toBe(0);
        expect(layout.items[0].x).not.toBe(layout.items[1].x);
        expect(layout.items[0].height).toBeGreaterThan(layout.items[0].width);
        expect(layout.items[1].width).toBeGreaterThan(layout.items[1].height);
        expect(layout.totalHeight).toBeGreaterThan(0);
    });

    it("stacks items in the shortest column", () => {
        const files = [
            fileWithDimensions(1, 100, 100),
            fileWithDimensions(2, 100, 300),
            fileWithDimensions(3, 100, 100),
        ];
        const layout = computeMasonryLayout(files, 320, 2);
        const firstColumnItems = layout.items.filter(
            (item) => item.x === layout.items[0].x,
        );

        expect(firstColumnItems).toHaveLength(2);
        expect(firstColumnItems[1].y).toBeGreaterThan(firstColumnItems[0].y);
    });
});
