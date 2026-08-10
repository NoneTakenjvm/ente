import { describe, expect, it } from "vitest";
import {
    CROP_SAD_THRESHOLD,
    TEMPLATE_GRID_SIZE,
    areCropMatches,
    colorHashFromImageData,
    decodeLuminanceGrid,
    encodeLuminanceGrid,
    hammingDistance,
    luminanceGridFromImageData,
    templateMatchScore,
} from "@/lib/crop-match";

/** Build an RGBA buffer of the given solid color. */
const solidRgba = (
    width: number,
    height: number,
    r: number,
    g: number,
    b: number,
): Uint8ClampedArray => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = 255;
    }
    return data;
};

/** A synthetic 48x48 grid: smooth gradient + a small grid of bright dots at a distinct layout. */
const makeGrid = (dotOffset: number): Uint8Array => {
    const grid = new Uint8Array(TEMPLATE_GRID_SIZE * TEMPLATE_GRID_SIZE);
    for (let row = 0; row < TEMPLATE_GRID_SIZE; row++) {
        for (let col = 0; col < TEMPLATE_GRID_SIZE; col++) {
            const base = 40 + ((row * 5 + col * 11) % 70);
            const dx = Math.abs((col + dotOffset * 3) % 48 - row);
            grid[row * TEMPLATE_GRID_SIZE + col] =
                dx < 4 ? 245 : Math.round(base);
        }
    }
    return grid;
};

/** RGBA image split vertically between two colors. */
const splitRgba = (
    width: number,
    height: number,
    left: [number, number, number],
    right: [number, number, number],
): Uint8ClampedArray => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = x < width / 2 ? left : right;
            const i = (y * width + x) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = 255;
        }
    }
    return data;
};

describe("crop-match grid codec", () => {
    it("round-trips a grid through base64", () => {
        const grid = makeGrid(2);
        expect(decodeLuminanceGrid(encodeLuminanceGrid(grid))).toEqual(grid);
    });

    it("luminance grid has expected size and values", () => {
        const data = solidRgba(96, 96, 255, 0, 0);
        const grid = luminanceGridFromImageData(data, 96, 96);
        expect(grid.length).toBe(TEMPLATE_GRID_SIZE * TEMPLATE_GRID_SIZE);
        expect(grid[0]).toBe(Math.round(0.299 * 255));
    });
});

describe("crop-match color hash", () => {
    it("is identical for same color", () => {
        const data = splitRgba(32, 32, [200, 100, 50], [10, 220, 150]);
        const hash = colorHashFromImageData(data, 32, 32);
        expect(hash).toBe(colorHashFromImageData(data, 32, 32));
        expect(hash).toHaveLength(16);
    });

    it("differs for very different palettes", () => {
        const warm = colorHashFromImageData(
            splitRgba(32, 32, [255, 90, 20], [240, 180, 60]),
            32,
            32,
        );
        const cool = colorHashFromImageData(
            splitRgba(32, 32, [10, 40, 210], [30, 200, 250]),
            32,
            32,
        );
        expect(hammingDistance(warm, cool)).toBeGreaterThan(2);
    });
});

describe("templateMatchScore", () => {
    it("scores a direct subcrop as a match", () => {
        const src = makeGrid(2);
        expect(templateMatchScore(
            encodeLuminanceGrid(src),
            encodeLuminanceGrid(src),
        )).toBeLessThanOrEqual(CROP_SAD_THRESHOLD);
    });

    it("scores a heavily different image above the threshold", () => {
        const a = makeGrid(2);
        const b = makeGrid(7); // different dot layout
        expect(templateMatchScore(
            encodeLuminanceGrid(a),
            encodeLuminanceGrid(b),
        )).toBeGreaterThan(CROP_SAD_THRESHOLD);
    });
});

describe("areCropMatches", () => {
    const warm = colorHashFromImageData(splitRgba(48, 48, [255, 90, 20], [240, 180, 60]), 48, 48);
    const cool = colorHashFromImageData(splitRgba(48, 48, [10, 40, 210], [30, 200, 250]), 48, 48);
    const grid = makeGrid(2);
    const gridB = makeGrid(7);

    it("matches identical images", () => {
        expect(areCropMatches(
            warm,
            encodeLuminanceGrid(grid),
            warm,
            encodeLuminanceGrid(grid),
        )).toBe(true);
    });

    it("rejects a very different palette", () => {
        expect(areCropMatches(
            warm,
            encodeLuminanceGrid(grid),
            cool,
            encodeLuminanceGrid(gridB),
        )).toBe(false);
    });

    it("rejects same palette but different geometry", () => {
        expect(areCropMatches(
            warm,
            encodeLuminanceGrid(grid),
            warm,
            encodeLuminanceGrid(gridB),
        )).toBe(false);
    });
});
