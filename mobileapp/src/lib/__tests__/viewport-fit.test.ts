import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    maxAspectRatioCrop,
    sortFilesByViewportFit,
    viewportBlankFraction,
    viewportCropFraction,
    viewportTargetAspectRatio,
} from "@/lib/viewport-fit";

const fileWithAspect = (id: number, width: number, height: number): EnteFile =>
    ({
        id,
        pubMagicMetadata: { data: { w: width, h: height } },
    }) as EnteFile;

describe("viewport-fit", () => {
    it("viewportTargetAspectRatio returns width/height for valid sizes", () => {
        expect(viewportTargetAspectRatio(390, 844)).toBeCloseTo(390 / 844);
        expect(viewportTargetAspectRatio(16, 9)).toBeCloseTo(16 / 9);
    });

    it("viewportTargetAspectRatio falls back to 1 for non-positive sizes", () => {
        expect(viewportTargetAspectRatio(0, 100)).toBe(1);
        expect(viewportTargetAspectRatio(100, 0)).toBe(1);
        expect(viewportTargetAspectRatio(-1, 10)).toBe(1);
    });

    it("maxAspectRatioCrop fills height when the image is wider than the target", () => {
        // Display 400×300 (4:3), target 9:16 portrait ≈ 0.5625
        expect(maxAspectRatioCrop(400, 300, 9 / 16)).toEqual({
            unit: "px",
            x: 116,
            y: 0,
            width: 169,
            height: 300,
        });
    });

    it("maxAspectRatioCrop fills width when the image is taller than the target", () => {
        // Display 300×400 (3:4), target 16:9 landscape
        expect(maxAspectRatioCrop(300, 400, 16 / 9)).toEqual({
            unit: "px",
            x: 0,
            y: 116,
            width: 300,
            height: 169,
        });
    });

    it("maxAspectRatioCrop matches the full frame when aspects are equal", () => {
        expect(maxAspectRatioCrop(360, 640, 360 / 640)).toEqual({
            unit: "px",
            x: 0,
            y: 0,
            width: 360,
            height: 640,
        });
    });

    it("viewportBlankFraction is 0 for a perfect match", () => {
        expect(viewportBlankFraction(9 / 16, 9 / 16)).toBe(0);
        expect(viewportCropFraction(9 / 16, 9 / 16)).toBe(0);
    });

    it("viewportBlankFraction grows with aspect mismatch", () => {
        const mild = viewportBlankFraction(1, 9 / 16);
        const severe = viewportBlankFraction(16 / 9, 9 / 16);
        expect(severe).toBeGreaterThan(mild);
        expect(mild).toBeGreaterThan(0);
    });

    it("sortFilesByViewportFit worst puts the largest mismatch first", () => {
        const viewport = 9 / 16;
        const files = [
            fileWithAspect(1, 9, 16), // perfect fit
            fileWithAspect(2, 16, 9), // severe landscape
            fileWithAspect(3, 4, 3), // mild landscape
        ];
        const ordered = sortFilesByViewportFit(files, "worst", viewport);
        expect(ordered.map((file) => file.id)).toEqual([2, 3, 1]);
    });

    it("sortFilesByViewportFit best puts the closest match first", () => {
        const viewport = 9 / 16;
        const files = [
            fileWithAspect(1, 9, 16),
            fileWithAspect(2, 16, 9),
            fileWithAspect(3, 4, 3),
        ];
        const ordered = sortFilesByViewportFit(files, "best", viewport);
        expect(ordered.map((file) => file.id)).toEqual([1, 3, 2]);
    });

    it("sortFilesByViewportFit none preserves input order in a copy", () => {
        const files = [
            fileWithAspect(3, 16, 9),
            fileWithAspect(1, 9, 16),
        ];
        const ordered = sortFilesByViewportFit(files, "none", 9 / 16);
        expect(ordered.map((file) => file.id)).toEqual([3, 1]);
        expect(ordered).not.toBe(files);
    });
});
