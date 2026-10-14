import { describe, expect, it } from "vitest";
import {
    containedBox,
    defaultNormalizedCrop,
    dragCropRect,
    fitRectToRatio,
    normalizedToPixelRect,
    type NormalizedCropRect,
} from "@/lib/crop-draft";

const expectRect = (
    actual: NormalizedCropRect,
    expected: NormalizedCropRect,
): void => {
    expect(actual.x).toBeCloseTo(expected.x);
    expect(actual.y).toBeCloseTo(expected.y);
    expect(actual.width).toBeCloseTo(expected.width);
    expect(actual.height).toBeCloseTo(expected.height);
};

describe("defaultNormalizedCrop", () => {
    it("trims the sides of a wide image", () => {
        expectRect(defaultNormalizedCrop(2, 1), {
            x: 0.25,
            y: 0,
            width: 0.5,
            height: 1,
        });
    });

    it("trims top and bottom of a tall image", () => {
        expectRect(defaultNormalizedCrop(0.5, 1), {
            x: 0,
            y: 0.25,
            width: 1,
            height: 0.5,
        });
    });

    it("covers the whole image when aspects match", () => {
        expectRect(defaultNormalizedCrop(0.5, 0.5), {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        });
    });
});

describe("containedBox", () => {
    it("adds side bars when the tile is wider than the image", () => {
        expect(containedBox(0.5, 200, 100)).toEqual({
            left: 75,
            top: 0,
            width: 50,
            height: 100,
        });
    });

    it("adds top and bottom bars when the tile is taller than the image", () => {
        expect(containedBox(2, 100, 100)).toEqual({
            left: 0,
            top: 25,
            width: 100,
            height: 50,
        });
    });

    it("fills the tile when aspects match", () => {
        expect(containedBox(2, 200, 100)).toEqual({
            left: 0,
            top: 0,
            width: 200,
            height: 100,
        });
    });
});

describe("dragCropRect", () => {
    const start: NormalizedCropRect = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
    const min = 0.1;

    it("moves the box", () => {
        expectRect(dragCropRect(start, "move", 0.1, -0.1, min, min), {
            x: 0.4,
            y: 0.2,
            width: 0.4,
            height: 0.4,
        });
    });

    it("stops a move at each image edge", () => {
        expect(dragCropRect(start, "move", -1, 0, min, min).x).toBe(0);
        expect(dragCropRect(start, "move", 1, 0, min, min).x).toBeCloseTo(0.6);
        expect(dragCropRect(start, "move", 0, -1, min, min).y).toBe(0);
        expect(dragCropRect(start, "move", 0, 1, min, min).y).toBeCloseTo(0.6);
    });

    it("resizes from each corner", () => {
        expectRect(dragCropRect(start, "nw", -0.1, -0.1, min, min), {
            x: 0.2,
            y: 0.2,
            width: 0.5,
            height: 0.5,
        });
        expectRect(dragCropRect(start, "ne", 0.1, -0.1, min, min), {
            x: 0.3,
            y: 0.2,
            width: 0.5,
            height: 0.5,
        });
        expectRect(dragCropRect(start, "sw", -0.1, 0.1, min, min), {
            x: 0.2,
            y: 0.3,
            width: 0.5,
            height: 0.5,
        });
        expectRect(dragCropRect(start, "se", 0.1, 0.1, min, min), {
            x: 0.3,
            y: 0.3,
            width: 0.5,
            height: 0.5,
        });
    });

    it("clamps each corner at the minimum size without flipping", () => {
        expectRect(dragCropRect(start, "nw", 1, 1, min, min), {
            x: 0.6,
            y: 0.6,
            width: 0.1,
            height: 0.1,
        });
        expectRect(dragCropRect(start, "ne", -1, 1, min, min), {
            x: 0.3,
            y: 0.6,
            width: 0.1,
            height: 0.1,
        });
        expectRect(dragCropRect(start, "sw", 1, -1, min, min), {
            x: 0.6,
            y: 0.3,
            width: 0.1,
            height: 0.1,
        });
        expectRect(dragCropRect(start, "se", -1, -1, min, min), {
            x: 0.3,
            y: 0.3,
            width: 0.1,
            height: 0.1,
        });
    });

    it("clamps each corner at the image edge", () => {
        expectRect(dragCropRect(start, "nw", -1, -1, min, min), {
            x: 0,
            y: 0,
            width: 0.7,
            height: 0.7,
        });
        expectRect(dragCropRect(start, "se", 1, 1, min, min), {
            x: 0.3,
            y: 0.3,
            width: 0.7,
            height: 0.7,
        });
    });

    it("keeps a box already below the minimum at its own size", () => {
        const thin: NormalizedCropRect = { x: 0.4, y: 0, width: 0.05, height: 1 };
        expect(dragCropRect(thin, "nw", 1, 0, min, min).width).toBeCloseTo(0.05);
    });
});

describe("normalizedToPixelRect", () => {
    it("scales to image pixels", () => {
        expect(
            normalizedToPixelRect(
                { x: 0.25, y: 0.1, width: 0.5, height: 0.8 },
                400,
                300,
            ),
        ).toEqual({ x: 100, y: 30, width: 200, height: 240 });
    });
});

describe("dragCropRect edges and locked ratio", () => {
    const start: NormalizedCropRect = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
    const min = 0.1;

    it("resizes from one edge only", () => {
        expectRect(dragCropRect(start, "e", 0.1, 0.5, min, min), {
            x: 0.3,
            y: 0.3,
            width: 0.5,
            height: 0.4,
        });
        expectRect(dragCropRect(start, "n", 0.5, -0.1, min, min), {
            x: 0.3,
            y: 0.2,
            width: 0.4,
            height: 0.5,
        });
    });

    it("keeps the ratio when a corner is dragged", () => {
        const rect = dragCropRect(start, "se", 0.1, 0.3, min, min, 1);
        expectRect(rect, { x: 0.3, y: 0.3, width: 0.5, height: 0.5 });
    });

    it("grows an edge drag about the center and stays inside the image", () => {
        const rect = dragCropRect(start, "e", 1, 0, min, min, 1);
        expect(rect.x).toBeCloseTo(0.3);
        expect(rect.width).toBeCloseTo(0.7);
        expect(rect.height).toBeCloseTo(0.7);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.y + rect.height).toBeLessThanOrEqual(1 + 1e-9);
    });
});

describe("fitRectToRatio", () => {
    it("shrinks about the center to the ratio", () => {
        expectRect(
            fitRectToRatio({ x: 0.1, y: 0.2, width: 0.8, height: 0.4 }, 1),
            { x: 0.3, y: 0.2, width: 0.4, height: 0.4 },
        );
    });
});
