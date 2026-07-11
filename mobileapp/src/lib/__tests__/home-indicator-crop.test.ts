import { describe, expect, it } from "vitest";
import {
    detectContentBoundsFromImageData,
    detectRawContentBoundsFromImageData,
    findBottomHomeIndicatorTop,
    rowLooksLikeHomeIndicator,
    trimBottomHomeIndicator,
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

describe("home indicator auto-crop trim", () => {
    it("detects a short centered bright bar on a full-width black row", () => {
        const width = 100;
        const data = new Uint8ClampedArray(width * 4);
        for (let x = 0; x < width; x++) {
            const bright = x >= 35 && x <= 64;
            const index = x * 4;
            data[index] = bright ? 255 : 0;
            data[index + 1] = bright ? 255 : 0;
            data[index + 2] = bright ? 255 : 0;
            data[index + 3] = 255;
        }
        expect(rowLooksLikeHomeIndicator(data, width, 0)).toBe(true);
    });

    it("detects anti-aliased grey edges as part of the bar", () => {
        const width = 100;
        const data = new Uint8ClampedArray(width * 4);
        for (let x = 0; x < width; x++) {
            const index = x * 4;
            let value = 0;
            if (x >= 36 && x <= 63) {
                value = 255;
            } else if (x === 35 || x === 64) {
                value = 120; // AA fringe — old detector rejected this
            }
            data[index] = value;
            data[index + 1] = value;
            data[index + 2] = value;
            data[index + 3] = 255;
        }
        expect(rowLooksLikeHomeIndicator(data, width, 0)).toBe(true);
    });

    it("finds indicator top from image bottom through letterbox", () => {
        const width = 120;
        const height = 160;
        const barTop = 140;
        const barBottom = 148;
        const imageData = rgbaImageData(width, height, (x, y) => {
            if (y >= barTop && y <= barBottom && x >= 40 && x <= 79) {
                return [255, 255, 255, 255];
            }
            return [0, 0, 0, 255];
        });
        expect(findBottomHomeIndicatorTop(imageData)).toBe(barTop);
    });

    it("trims a centered bright bar when content bounds hug the bar tightly", () => {
        const width = 120;
        const height = 160;
        const barTop = 140;
        const barBottom = 148;
        const barLeft = 40;
        const barRight = 79;

        const imageData = rgbaImageData(width, height, (x, y) => {
            if (y >= barTop && y <= barBottom && x >= barLeft && x <= barRight) {
                return [255, 255, 255, 255];
            }
            return [0, 0, 0, 255];
        });

        const raw = detectRawContentBoundsFromImageData(imageData)!;
        expect(raw.width).toBe(barRight - barLeft + 1);

        const trimmed = trimBottomHomeIndicator(imageData, raw);
        expect(trimmed.y + trimmed.height - 1).toBeLessThan(barTop);

        const detected = detectContentBoundsFromImageData(imageData);
        expect(detected).toBeDefined();
        expect(detected!.y + detected!.height - 1).toBeLessThan(barTop);
    });

    it("trims black letterbox trapped between content and the home indicator", () => {
        // top black | content | bottom black | white bar
        const width = 100;
        const height = 120;
        const contentTop = 20;
        const contentBottom = 70;
        const letterboxEnd = 100;
        const barTop = 101;
        const barBottom = 108;

        const imageData = rgbaImageData(width, height, (x, y) => {
            if (y >= barTop && y <= barBottom && x >= 35 && x <= 64) {
                return [255, 255, 255, 255];
            }
            if (
                y >= contentTop &&
                y <= contentBottom &&
                x >= 10 &&
                x < 90
            ) {
                return [40, 80, 120, 255];
            }
            return [0, 0, 0, 255];
        });

        const detected = detectContentBoundsFromImageData(imageData)!;
        expect(detected.y).toBe(contentTop);
        expect(detected.y + detected.height - 1).toBe(contentBottom);
        expect(detected.y + detected.height - 1).toBeLessThan(letterboxEnd);
    });

    it("leaves normal bright content bottoms alone", () => {
        const imageData = rgbaImageData(60, 40, (x, y) => {
            if (y < 5 || y >= 35 || x < 5 || x >= 55) {
                return [0, 0, 0, 255];
            }
            return [220, 220, 220, 255];
        });
        const raw = detectRawContentBoundsFromImageData(imageData)!;
        const trimmed = trimBottomHomeIndicator(imageData, raw);
        expect(trimmed).toEqual(raw);
    });
});
