import { describe, expect, it } from "vitest";
import {
    containedDisplaySize,
    cropRectForSave,
    dimensionsAfterQuarterTurn,
    dimensionsAfterRotation,
    fullFramePixelCrop,
    fullImageCrop,
} from "@/lib/crop-editor";

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
});
