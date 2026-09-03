import { describe, expect, it } from "vitest";
import {
    computeDHashFromLuminance,
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
});
