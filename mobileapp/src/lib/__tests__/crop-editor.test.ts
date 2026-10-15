import { describe, expect, it } from "vitest";
import {
    detectContentBoundsFromImageData,
    isBorderPixel,
} from "@/lib/content-bounds";
import { containedDisplaySize } from "@/lib/crop-editor";
import { rgbaImageData } from "@/test-utils/fixtures";

describe("crop-editor helpers", () => {
    it("containedDisplaySize fits large photos into the workspace box", () => {
        expect(containedDisplaySize(4032, 3024, 358, 600)).toEqual({
            width: 358,
            height: 269,
        });
    });

    it("containedDisplaySize does not upscale small images", () => {
        expect(containedDisplaySize(640, 480, 800, 600)).toEqual({
            width: 640,
            height: 480,
        });
    });

    it("isBorderPixel treats near-black and transparent pixels as border", () => {
        expect(isBorderPixel(0, 0, 0, 255)).toBe(true);
        expect(isBorderPixel(10, 10, 10, 255)).toBe(true);
        expect(isBorderPixel(0, 0, 0, 0)).toBe(true);
        expect(isBorderPixel(20, 0, 0, 255)).toBe(false);
    });

    it("detectContentBoundsFromImageData trims black borders", () => {
        const imageData = rgbaImageData(100, 80, (x, y) => {
            if (y < 30 || x < 10 || x >= 90 || y >= 70) {
                return [0, 0, 0, 255];
            }
            return [255, 255, 255, 255];
        });
        expect(detectContentBoundsFromImageData(imageData)).toEqual({
            x: 10,
            y: 30,
            width: 80,
            height: 40,
        });
    });

    it("detectContentBoundsFromImageData returns undefined for empty frames", () => {
        const imageData = rgbaImageData(20, 20, () => [0, 0, 0, 255]);
        expect(detectContentBoundsFromImageData(imageData)).toBeUndefined();
    });
});
