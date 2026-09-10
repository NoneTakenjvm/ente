import { describe, expect, it } from "vitest";
import { fileAspectRatio } from "@/lib/file-aspect-ratio";
import {
    computeMasonryLayout,
    groupMasonryItemsByColumn,
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
        const columns = groupMasonryItemsByColumn(layout.items);
        const visible = visibleMasonryItemsFromColumns(columns, 0, 80, 0);

        expect(visible.length).toBeGreaterThan(0);
        expect(visible.length).toBeLessThan(layout.items.length);
        for (const item of visible) {
            expect(item.y).toBeLessThanOrEqual(80);
            expect(item.y + item.height).toBeGreaterThanOrEqual(0);
        }
    });
});
