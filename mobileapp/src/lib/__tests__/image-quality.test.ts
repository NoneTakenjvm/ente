import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    scoreImageQuality,
    sortFilesByImageQuality,
} from "@/lib/image-quality";

const rgbaImageData = (
    width: number,
    height: number,
    pixel: (x: number, y: number) => [number, number, number, number],
): ImageData => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b, a] = pixel(x, y);
            const i = (y * width + x) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = a;
        }
    }
    return { width, height, data, colorSpace: "srgb" } as ImageData;
};

const flatGray = (width: number, height: number, value: number): ImageData =>
    rgbaImageData(width, height, () => [value, value, value, 255]);

const checkerboard = (width: number, height: number, block: number): ImageData =>
    rgbaImageData(width, height, (x, y) => {
        const on =
            (Math.floor(x / block) + Math.floor(y / block)) % 2 === 0;
        const v = on ? 240 : 20;
        return [v, v, v, 255];
    });

const noisyGray = (width: number, height: number, seed: number): ImageData =>
    rgbaImageData(width, height, (x, y) => {
        // Deterministic pseudo-noise (no Math.random).
        const n = ((x * 374761393 + y * 668265263 + seed) >>> 0) % 256;
        return [n, n, n, 255];
    });

const sharpEdges = (width: number, height: number): ImageData =>
    rgbaImageData(width, height, (x, _y) => {
        // Soft gradient with hard vertical edges (structured detail).
        const base = Math.floor((x / width) * 180) + 40;
        const edge = x % 32 < 2 ? 255 : base;
        return [edge, edge, edge, 255];
    });

/** Large flat blocks (strong 16px grid) — pixelation proxy. */
const blockyPixels = (width: number, height: number): ImageData =>
    checkerboard(width, height, 16);

/** Mild structured detail without block grid. */
const smoothDetail = (width: number, height: number): ImageData =>
    rgbaImageData(width, height, (x, y) => {
        const v =
            80 +
            Math.floor(40 * Math.sin((x / width) * Math.PI * 4)) +
            Math.floor(30 * Math.cos((y / height) * Math.PI * 3));
        return [v, v, v, 255];
    });

describe("scoreImageQuality", () => {
    it("scores flat blurry low-res lower than sharp high-res", () => {
        const blurry = scoreImageQuality(
            flatGray(64, 64, 128),
            320,
            240,
            20_000,
        );
        const sharp = scoreImageQuality(
            sharpEdges(128, 128),
            4000,
            3000,
            2_500_000,
        );
        expect(sharp).toBeGreaterThan(blurry);
    });

    it("penalizes heavy grain relative to a clean flat field", () => {
        const clean = scoreImageQuality(
            flatGray(96, 96, 120),
            2000,
            1500,
            800_000,
        );
        const grainy = scoreImageQuality(
            noisyGray(96, 96, 7),
            2000,
            1500,
            800_000,
        );
        expect(clean).toBeGreaterThan(grainy);
    });

    it("penalizes coarse block pixelation vs smoother detail", () => {
        const blocky = scoreImageQuality(
            blockyPixels(128, 128),
            800,
            600,
            120_000,
        );
        const fine = scoreImageQuality(
            smoothDetail(128, 128),
            800,
            600,
            120_000,
        );
        expect(fine).toBeGreaterThan(blocky);
    });

    it("returns a value in [0, 1]", () => {
        const score = scoreImageQuality(
            sharpEdges(48, 48),
            1000,
            1000,
            500_000,
        );
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
    });
});

describe("sortFilesByImageQuality", () => {
    const files = [
        { id: 1 } as EnteFile,
        { id: 2 } as EnteFile,
        { id: 3 } as EnteFile,
        { id: 4 } as EnteFile,
    ];
    const scores = new Map<number, number>([
        [1, 0.2],
        [2, 0.9],
        [3, 0.5],
    ]);

    it("worst puts lowest known score first and unscanned last", () => {
        expect(
            sortFilesByImageQuality(files, "worst", scores).map((f) => f.id),
        ).toEqual([1, 3, 2, 4]);
    });

    it("best puts highest known score first and unscanned last", () => {
        expect(
            sortFilesByImageQuality(files, "best", scores).map((f) => f.id),
        ).toEqual([2, 3, 1, 4]);
    });

    it("none returns a shallow copy in the same order", () => {
        const ordered = sortFilesByImageQuality(files, "none", scores);
        expect(ordered.map((f) => f.id)).toEqual([1, 2, 3, 4]);
        expect(ordered).not.toBe(files);
    });
});
