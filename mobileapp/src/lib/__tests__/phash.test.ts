import { describe, expect, it } from "vitest";
import {
    computeDHashFromLuminance,
    dHashVariantsFromImageData,
    hammingDistance,
    hammingDistancePacked,
    parseDHashHex,
    variantHammingDistance,
    variantHammingDistanceHex,
} from "@/lib/phash";

describe("phash", () => {
    it("returns zero distance for identical hashes", () => {
        expect(hammingDistance(
            "0000000000000000",
            "0000000000000000",
        )).toBe(0);
    });

    it("counts bit differences", () => {
        expect(hammingDistance(
            "0000000000000000",
            "0000000000000001",
        )).toBe(1);
    });

    it("packed Hamming matches string Hamming", () => {
        const left = "a1bf0c0d12345678";
        const right = "a1bf0c0d12345679";
        expect(hammingDistancePacked(parseDHashHex(left), parseDHashHex(right))).toBe(
            hammingDistance(left, right),
        );
        expect(hammingDistance(left, left)).toBe(0);
    });

    it("variant distance short-circuits on exact primary match", () => {
        const primary = parseDHashHex("aaaaaaaaaaaaaaaa");
        const other = parseDHashHex("bbbbbbbbbbbbbbbb");
        expect(
            variantHammingDistance([primary, other], [primary, other]),
        ).toBe(0);
        expect(
            variantHammingDistanceHex(
                ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
                ["bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa"],
            ),
        ).toBe(0);
    });

    it("builds stable dHash from luminance grid", () => {
        const samples = new Uint8Array(9 * 8);
        for (let i = 0; i < samples.length; i++) {
            samples[i] = i % 2 === 0 ? 200 : 50;
        }
        const hash = computeDHashFromLuminance(samples, 9, 8);
        expect(hash).toHaveLength(16);
        expect(hash).toBe(computeDHashFromLuminance(samples, 9, 8));
        const packed = parseDHashHex(hash);
        expect(hammingDistancePacked(packed, packed)).toBe(0);
    });

    it("hashes rotated and mirrored images to the same variant set", () => {
        // 144×72 divides evenly into both 9×8 and 8×9 grids, so variants of
        // pixel-rotated copies must match exactly.
        const width = 144;
        const height = 72;
        const value = (x: number, y: number): number =>
            (x * 7 + y * 13 + ((x * y) % 31)) % 256;
        const imageOf = (
            w: number,
            h: number,
            pixel: (x: number, y: number) => number,
        ): Uint8ClampedArray => {
            const data = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const v = pixel(x, y);
                    data.set([v, v, v, 255], (y * w + x) * 4);
                }
            }
            return data;
        };
        const upright = dHashVariantsFromImageData(
            imageOf(width, height, value),
            width,
            height,
        );
        // 90° clockwise: rotated (x, y) reads source (y, height - 1 - x).
        const rotated = dHashVariantsFromImageData(
            imageOf(height, width, (x, y) => value(y, height - 1 - x)),
            height,
            width,
        );
        const mirrored = dHashVariantsFromImageData(
            imageOf(width, height, (x, y) => value(width - 1 - x, y)),
            width,
            height,
        );
        expect(new Set(upright).size).toBeGreaterThan(1);
        expect([...rotated].sort()).toEqual([...upright].sort());
        expect([...mirrored].sort()).toEqual([...upright].sort());
        expect(rotated[0]).not.toBe(upright[0]);
    });
});
