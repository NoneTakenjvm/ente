import { describe, expect, it } from "vitest";
import {
    avifQualityForPreset,
    mimeTypeForPreset,
    routeFromFeatures,
    type ImageCompressFeatures,
} from "@/lib/compress-classify";

const photoFeatures = (
    overrides: Partial<ImageCompressFeatures> = {},
): ImageCompressFeatures => ({
    width: 4000,
    height: 3000,
    megapixels: 12,
    fileBytes: 2_500_000,
    bpp: 3.2,
    uniqueColors: 2000,
    colorScore: 0.8,
    flatRatio: 0.05,
    edgeDensity: 0.2,
    hvDominance: 0.3,
    anisotropy: 1.2,
    ...overrides,
});

describe("routeFromFeatures", () => {
    it("skips files under the configured minimum size", () => {
        const decision = routeFromFeatures(
            photoFeatures({ fileBytes: 400_000 }),
            800 * 1024,
        );
        expect(decision.preset).toBe("skip");
    });

    it("does not skip on size when the floor is 0", () => {
        const decision = routeFromFeatures(
            photoFeatures({ fileBytes: 400_000 }),
            0,
        );
        expect(decision.preset).toBe("avif-q60");
    });

    it("defaults to avif-q60 for normal photos", () => {
        expect(routeFromFeatures(photoFeatures(), 800 * 1024).preset).toBe(
            "avif-q60",
        );
    });

    it("uses avif-q70 for already-crushed photos", () => {
        const decision = routeFromFeatures(
            photoFeatures({ bpp: 1.4, megapixels: 3, fileBytes: 1_200_000 }),
            800 * 1024,
        );
        expect(decision.preset).toBe("avif-q70");
    });

    it("uses avif-q80 for very crushed files", () => {
        const decision = routeFromFeatures(
            photoFeatures({ bpp: 1.0, megapixels: 2, fileBytes: 1_200_000 }),
            800 * 1024,
        );
        expect(decision.preset).toBe("avif-q80");
    });

    it("uses lossless webp for strong graphics", () => {
        const decision = routeFromFeatures(
            photoFeatures({
                colorScore: 0.2,
                uniqueColors: 200,
                flatRatio: 0.55,
                edgeDensity: 0.12,
                hvDominance: 0.7,
                anisotropy: 2.2,
                fileBytes: 1_500_000,
            }),
            800 * 1024,
        );
        expect(decision.preset).toBe("lossless-webp");
    });

    it("uses avif-q80 for graphics-ish content", () => {
        const decision = routeFromFeatures(
            photoFeatures({
                colorScore: 0.2,
                uniqueColors: 400,
                flatRatio: 0.4,
                edgeDensity: 0.04,
                hvDominance: 0.4,
                anisotropy: 1.2,
                fileBytes: 1_500_000,
            }),
            800 * 1024,
        );
        expect(decision.preset).toBe("avif-q80");
    });
});

describe("preset mime", () => {
    it("maps avif and webp presets", () => {
        expect(mimeTypeForPreset("avif-q60")).toEqual({
            mimeType: "image/avif",
            extension: "avif",
        });
        expect(mimeTypeForPreset("lossless-webp")).toEqual({
            mimeType: "image/webp",
            extension: "webp",
        });
        expect(avifQualityForPreset("avif-q70")).toBe(70);
    });
});
