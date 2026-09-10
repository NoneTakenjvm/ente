import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    resolutionQualityScore,
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

const sharpEdges = (width: number, height: number): ImageData =>
    rgbaImageData(width, height, (x, _y) => {
        const base = Math.floor((x / width) * 180) + 40;
        const edge = x % 32 < 2 ? 255 : base;
        return [edge, edge, edge, 255];
    });

/** Soft-focus version of sharpEdges via repeated box blur. */
const softBlur = (source: ImageData, passes: number): ImageData => {
    let cur = source;
    for (let p = 0; p < passes; p++) {
        const next = new Uint8ClampedArray(cur.data.length);
        const { width: w, height: h, data } = cur;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let r = 0;
                let g = 0;
                let b = 0;
                let n = 0;
                for (let dy = -2; dy <= 2; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= h) {
                        continue;
                    }
                    for (let dx = -2; dx <= 2; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= w) {
                            continue;
                        }
                        const i = (yy * w + xx) * 4;
                        r += data[i] ?? 0;
                        g += data[i + 1] ?? 0;
                        b += data[i + 2] ?? 0;
                        n += 1;
                    }
                }
                const o = (y * w + x) * 4;
                next[o] = Math.round(r / n);
                next[o + 1] = Math.round(g / n);
                next[o + 2] = Math.round(b / n);
                next[o + 3] = 255;
            }
        }
        cur = { width: w, height: h, data: next, colorSpace: "srgb" } as ImageData;
    }
    return cur;
};

describe("resolutionQualityScore", () => {
    it("is near 0 for sub-VGA and 1 for 4K-class long edges", () => {
        expect(resolutionQualityScore(640, 480)).toBe(0);
        expect(resolutionQualityScore(4000, 3000)).toBe(1);
        expect(resolutionQualityScore(1920, 1080)).toBeGreaterThan(0.4);
        expect(resolutionQualityScore(1920, 1080)).toBeLessThan(0.8);
    });
});

describe("scoreImageQuality", () => {
    it("scores flat blurry much lower than sharp content", () => {
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
        expect(sharp).toBeGreaterThan(blurry + 0.25);
    });

    it("does not let soft high-res beat sharp high-res", () => {
        const crisp = sharpEdges(128, 128);
        const soft = softBlur(crisp, 3);
        const sharpScore = scoreImageQuality(crisp, 4000, 3000, 2_500_000);
        const softScore = scoreImageQuality(soft, 4000, 3000, 2_500_000);
        expect(sharpScore).toBeGreaterThan(softScore);
    });

    it("lets sharp mid-res beat soft high-res (content over megapixels)", () => {
        const crisp = sharpEdges(128, 128);
        const soft = softBlur(crisp, 4);
        const sharpMid = scoreImageQuality(crisp, 1600, 1200, 600_000);
        const softHuge = scoreImageQuality(soft, 4000, 3000, 2_500_000);
        expect(sharpMid).toBeGreaterThan(softHuge);
    });

    it("still prefers the same crisp content at higher native res", () => {
        const thumb = sharpEdges(128, 128);
        const lowRes = scoreImageQuality(thumb, 800, 600, 120_000);
        const highRes = scoreImageQuality(thumb, 4000, 3000, 2_500_000);
        expect(highRes).toBeGreaterThan(lowRes);
        expect(lowRes).toBeGreaterThan(0.3);
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
