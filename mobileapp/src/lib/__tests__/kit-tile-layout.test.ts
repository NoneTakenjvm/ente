import { describe, expect, it } from "vitest";
import { kitTileGrid } from "@/lib/kit-tile-layout";

/** Every pixel of the frame lies inside at least one tile. */
const coversFrame = (width: number, height: number): boolean => {
    const { rects } = kitTileGrid(width, height);
    const covered = new Uint8Array(width * height);
    for (const { x, y, size } of rects) {
        for (let row = y; row < y + size; row += 1) {
            covered.fill(1, row * width + x, row * width + x + size);
        }
    }
    return covered.every((value) => value === 1);
};

describe("kitTileGrid", () => {
    it("uses shortest-edge thirds and snaps the last column to the edge", () => {
        const grid = kitTileGrid(720, 480);
        expect(grid.rows).toBe(3);
        expect(grid.columns).toBe(5);
        expect(grid.rects).toHaveLength(15);
        expect(grid.rects.every((rect) => rect.size === 160)).toBe(true);
        // Row-major, last column clamped to width − size.
        expect(grid.rects.slice(0, 5).map((rect) => rect.x)).toEqual([
            0, 160, 320, 480, 560,
        ]);
        expect(grid.rects.slice(0, 5).every((rect) => rect.y === 0)).toBe(true);
        expect(grid.rects[5]!.y).toBe(160);
    });

    it("matches the documented shapes", () => {
        expect(kitTileGrid(720, 540)).toMatchObject({ rows: 3, columns: 4 });
        expect(kitTileGrid(600, 600)).toMatchObject({ rows: 3, columns: 3 });
        expect(kitTileGrid(720, 405)).toMatchObject({ rows: 3, columns: 6 });
        expect(kitTileGrid(480, 720)).toMatchObject({ rows: 5, columns: 3 });
    });

    it("covers the whole frame and stays in bounds", () => {
        for (const [width, height] of [
            [720, 480],
            [720, 540],
            [640, 640],
            [405, 720],
            [700, 101],
        ] as const) {
            const { rects } = kitTileGrid(width, height);
            for (const { x, y, size } of rects) {
                expect(x).toBeGreaterThanOrEqual(0);
                expect(y).toBeGreaterThanOrEqual(0);
                expect(x + size).toBeLessThanOrEqual(width);
                expect(y + size).toBeLessThanOrEqual(height);
            }
            expect(coversFrame(width, height)).toBe(true);
        }
    });
});
