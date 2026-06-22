import { describe, expect, it } from "vitest";
import {
    computeDHashFromLuminance,
    hammingDistance,
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

    it("builds stable dHash from luminance grid", () => {
        const samples = new Uint8Array(9 * 8);
        for (let i = 0; i < samples.length; i++) {
            samples[i] = i % 2 === 0 ? 200 : 50;
        }
        const hash = computeDHashFromLuminance(samples, 9, 8);
        expect(hash).toHaveLength(16);
        expect(hash).toBe(computeDHashFromLuminance(samples, 9, 8));
    });
});
