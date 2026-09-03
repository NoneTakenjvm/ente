import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    maxAspectRatioCrop,
    sortFilesByViewportFit,
    viewportBlankFraction,
    viewportCropFraction,
} from "@/lib/viewport-fit";

const fileWithAspect = (id: number, width: number, height: number): EnteFile =>
    ({
        id,
        pubMagicMetadata: { data: { w: width, h: height } },
    }) as EnteFile;

describe("viewport-fit", () => {
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

    it("sortFilesByViewportFit puts the worst blank-space mismatch first", () => {
        const viewport = 9 / 16;
        const files = [
            fileWithAspect(1, 9, 16), // perfect fit
            fileWithAspect(2, 16, 9), // severe landscape
            fileWithAspect(3, 4, 3), // mild landscape
        ];
        const ordered = sortFilesByViewportFit(files, "blank-space", viewport);
        expect(ordered.map((file) => file.id)).toEqual([2, 3, 1]);
    });

    it("sortFilesByViewportFit too-large uses the same mismatch ranking", () => {
        const viewport = 9 / 16;
        const files = [
            fileWithAspect(1, 9, 16),
            fileWithAspect(2, 16, 9),
            fileWithAspect(3, 4, 3),
        ];
        const blank = sortFilesByViewportFit(files, "blank-space", viewport);
        const large = sortFilesByViewportFit(files, "too-large", viewport);
        expect(large.map((file) => file.id)).toEqual(
            blank.map((file) => file.id),
        );
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
