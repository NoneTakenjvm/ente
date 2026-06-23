import { describe, expect, it } from "vitest";
import {
    containedDisplaySize,
    cropRectForSave,
    detectContentBoundsFromImageData,
    dimensionsAfterQuarterTurn,
    dimensionsAfterRotation,
    fullFramePixelCrop,
    fullImageCrop,
    initialCropForDisplay,
    isBorderPixel,
} from "@/lib/crop-editor";

const rgbaImageData = (
    width: number,
    height: number,
    pixelAt: (x: number, y: number) => [number, number, number, number],
): ImageData => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [red, green, blue, alpha] = pixelAt(x, y);
            const index = (y * width + x) * 4;
            data[index] = red;
            data[index + 1] = green;
            data[index + 2] = blue;
            data[index + 3] = alpha;
        }
    }
    return { width, height, data, colorSpace: "srgb" } as ImageData;
};

describe("crop-editor helpers", () => {
    it("fullImageCrop spans the full display frame", () => {
        expect(fullImageCrop(640, 480)).toEqual({
            unit: "px",
            x: 0,
            y: 0,
            width: 640,
            height: 480,
        });
    });

    it("fullFramePixelCrop matches fullImageCrop dimensions", () => {
        expect(fullFramePixelCrop(320, 200)).toEqual({
            unit: "px",
            x: 0,
            y: 0,
            width: 320,
            height: 200,
        });
    });

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

    it("dimensionsAfterQuarterTurn swaps width and height", () => {
        expect(dimensionsAfterQuarterTurn(400, 300)).toEqual({
            width: 300,
            height: 400,
        });
    });

    it("dimensionsAfterRotation leaves size unchanged for 180°", () => {
        expect(dimensionsAfterRotation(400, 300, 180)).toEqual({
            width: 400,
            height: 300,
        });
    });

    it("cropRectForSave maps object-contain display coords to natural pixels", () => {
        expect(
            cropRectForSave(
                { unit: "px", x: 10, y: 20, width: 100, height: 50 },
                {
                    width: 400,
                    height: 300,
                    naturalWidth: 800,
                    naturalHeight: 600,
                },
            ),
        ).toEqual({ x: 20, y: 40, width: 200, height: 100 });
    });

    it("cropRectForSave uses 1:1 mapping when display equals natural (baked rotate path)", () => {
        expect(
            cropRectForSave(
                { unit: "px", x: 0, y: 0, width: 50, height: 80 },
                {
                    width: 200,
                    height: 320,
                    naturalWidth: 200,
                    naturalHeight: 320,
                },
            ),
        ).toEqual({ x: 0, y: 0, width: 50, height: 80 });
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

    it("initialCropForDisplay maps trimmed content bounds into display space", () => {
        expect(
            initialCropForDisplay(400, 300, 800, 600, {
                x: 0,
                y: 300,
                width: 800,
                height: 300,
            }),
        ).toEqual({
            unit: "px",
            x: 0,
            y: 150,
            width: 400,
            height: 150,
        });
    });

    it("initialCropForDisplay falls back to full frame when no trim is needed", () => {
        expect(initialCropForDisplay(400, 300, 800, 600)).toEqual(
            fullImageCrop(400, 300),
        );
    });
});
