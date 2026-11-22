import { describe, expect, it } from "vitest";
import { fileAspectRatio } from "@/lib/file-aspect-ratio";
import {
    computeMasonryLayout,
    masonryViewOrderKey,
    visibleMasonryItemsFromColumns,
} from "@/lib/masonry-layout";
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

    it("groups every item into a column without duplicating", () => {
        const files = [
            fileWithDimensions(1, 100, 100),
            fileWithDimensions(2, 100, 200),
            fileWithDimensions(3, 100, 100),
            fileWithDimensions(4, 200, 100),
        ];
        const layout = computeMasonryLayout(files, 320, 2);
        const columnCount = layout.itemsByColumn.reduce(
            (sum, column) => sum + column.length,
            0,
        );
        expect(layout.itemsByColumn).toHaveLength(2);
        expect(columnCount).toBe(layout.items.length);
        expect(layout.items.map((item) => item.index)).toEqual([0, 1, 2, 3]);
    });
});

describe("visibleMasonryItemsFromColumns", () => {
    it("returns only items overlapping the viewport", () => {
        const files = Array.from({ length: 20 }, (_, index) =>
            fileWithDimensions(index + 1, 100, 100));
        const layout = computeMasonryLayout(files, 320, 2);
        const visible = visibleMasonryItemsFromColumns(
            layout.itemsByColumn,
            0,
            80,
            0,
        );

        expect(visible.length).toBeGreaterThan(0);
        expect(visible.length).toBeLessThan(layout.items.length);
        for (const item of visible) {
            expect(item.y).toBeLessThanOrEqual(80);
            expect(item.y + item.height).toBeGreaterThanOrEqual(0);
        }
    });
});

describe("computeMasonryLayout sections and square tiles", () => {
    const sections = [
        { label: "Day one", start: 0, count: 3 },
        { label: "Day two", start: 3, count: 2 },
    ];
    const files = Array.from({ length: 5 }, (_, index) =>
        fileWithDimensions(index + 1, 100, 100 + index * 50));

    it("starts each section below its header and below every earlier tile", () => {
        const layout = computeMasonryLayout(files, 320, 2, { sections });
        const [dayOne, dayTwo] = layout.headers;
        const dayOneItems = layout.items.slice(0, 3);
        const dayTwoItems = layout.items.slice(3);

        expect(layout.headers.map((header) => header.label)).toEqual([
            "Day one",
            "Day two",
        ]);
        for (const item of dayOneItems) {
            expect(item.y).toBeGreaterThanOrEqual(dayOne.y + dayOne.height);
            expect(dayTwo.y).toBeGreaterThanOrEqual(item.y + item.height);
        }
        for (const item of dayTwoItems) {
            expect(item.y).toBeGreaterThanOrEqual(dayTwo.y + dayTwo.height);
        }
    });

    it("places square tiles row-major", () => {
        const squares = Array.from({ length: 4 }, (_, index) =>
            fileWithDimensions(index + 1, 100, 300));
        const [topLeft, topRight, bottomLeft, bottomRight] =
            computeMasonryLayout(squares, 320, 2, { squareTiles: true }).items;

        expect(topLeft.height).toBe(topLeft.width);
        expect(topRight.y).toBe(topLeft.y);
        expect(bottomLeft.x).toBe(topLeft.x);
        expect(bottomLeft.y).toBeGreaterThan(topLeft.y);
        expect(bottomRight.x).toBe(topRight.x);
        expect(bottomRight.y).toBe(bottomLeft.y);
    });

    it("returns no headers without sections", () => {
        const layout = computeMasonryLayout(files, 320, 2);
        expect(layout.headers).toEqual([]);
    });
});

describe("masonryViewOrderKey", () => {
    it("is stable for the same id order and changes when order changes", () => {
        const a = [fileWithDimensions(1, 1, 1), fileWithDimensions(2, 1, 1)];
        const b = [fileWithDimensions(2, 1, 1), fileWithDimensions(1, 1, 1)];
        expect(masonryViewOrderKey(a)).toBe(masonryViewOrderKey(a));
        expect(masonryViewOrderKey(a)).not.toBe(masonryViewOrderKey(b));
    });
});
