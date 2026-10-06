import { describe, expect, it } from "vitest";
import {
    contentRectToViewport,
    gridIndicesInContentMarquee,
    keysInContentMarquee,
    marqueeEdgeScrollDelta,
    marqueeTouchIntent,
    normalizeRect,
    rectsOverlap,
    shouldArmMarquee,
} from "@/lib/marquee-selection";

describe("marquee-selection", () => {
    it("shouldArmMarquee arms on any-direction drag past threshold", () => {
        expect(shouldArmMarquee(20, 4, 12)).toBe(true);
        expect(shouldArmMarquee(4, 20, 12)).toBe(true);
        expect(shouldArmMarquee(4, 4, 12)).toBe(false);
    });

    it("marqueeTouchIntent selects on sideways drags and scrolls on vertical", () => {
        expect(marqueeTouchIntent(20, 4, 12)).toBe("select");
        expect(marqueeTouchIntent(-20, 10, 12)).toBe("select");
        expect(marqueeTouchIntent(4, 20, 12)).toBe("scroll");
        expect(marqueeTouchIntent(14, 14, 12)).toBe("scroll");
        expect(marqueeTouchIntent(4, 4, 12)).toBeUndefined();
    });

    it("marqueeEdgeScrollDelta scrolls near top and bottom", () => {
        expect(marqueeEdgeScrollDelta(0, 400, 48, 28)).toBe(-28);
        expect(marqueeEdgeScrollDelta(24, 400, 48, 28)).toBe(-14);
        expect(marqueeEdgeScrollDelta(200, 400, 48, 28)).toBe(0);
        expect(marqueeEdgeScrollDelta(400, 400, 48, 28)).toBe(28);
        expect(marqueeEdgeScrollDelta(376, 400, 48, 28)).toBe(14);
    });

    it("contentRectToViewport subtracts scrollTop from y", () => {
        expect(
            contentRectToViewport(
                { x: 10, y: 200, width: 40, height: 80 },
                150,
            ),
        ).toEqual({ x: 10, y: 50, width: 40, height: 80 });
    });

    it("rectsOverlap requires positive area", () => {
        expect(
            rectsOverlap(
                { x: 0, y: 0, width: 10, height: 10 },
                { x: 10, y: 0, width: 10, height: 10 },
            ),
        ).toBe(false);
        expect(
            rectsOverlap(
                { x: 0, y: 0, width: 10, height: 10 },
                { x: 9, y: 0, width: 10, height: 10 },
            ),
        ).toBe(true);
    });

    it("keysInContentMarquee hits only overlapping masonry boxes", () => {
        const items = [
            { key: 1, x: 0, y: 0, width: 100, height: 200 },
            { key: 2, x: 110, y: 0, width: 100, height: 50 },
            { key: 3, x: 0, y: 220, width: 100, height: 100 },
        ];
        expect(
            keysInContentMarquee(items, {
                x: 0,
                y: 0,
                width: 50,
                height: 50,
            }),
        ).toEqual([1]);
        expect(
            keysInContentMarquee(items, {
                x: 0,
                y: 180,
                width: 50,
                height: 20,
            }),
        ).toEqual([1]);
        expect(
            keysInContentMarquee(items, {
                x: 0,
                y: 200,
                width: 50,
                height: 15,
            }),
        ).toEqual([]);
        expect(
            keysInContentMarquee(items, {
                x: 0,
                y: 210,
                width: 50,
                height: 30,
            }),
        ).toEqual([3]);
    });

    it("gridIndicesInContentMarquee uses content rows", () => {
        // 2 columns, rowHeight 110, itemSize 100, gap 10, pad 4
        expect(
            gridIndicesInContentMarquee(
                6,
                2,
                110,
                100,
                4,
                10,
                { x: 4, y: 0, width: 50, height: 50 },
            ),
        ).toEqual([0]);
        expect(
            gridIndicesInContentMarquee(
                6,
                2,
                110,
                100,
                4,
                10,
                { x: 4, y: 120, width: 50, height: 50 },
            ),
        ).toEqual([2]);
        expect(
            gridIndicesInContentMarquee(
                6,
                2,
                110,
                100,
                4,
                10,
                normalizeRect({ x: 0, y: 0 }, { x: 200, y: 250 }),
            ),
        ).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("gridIndicesInContentMarquee ignores rows outside the rect", () => {
        // 1000 rows of 3; rect covers only row 500.
        expect(
            gridIndicesInContentMarquee(
                3000,
                3,
                110,
                100,
                4,
                10,
                { x: 0, y: 500 * 110 + 10, width: 400, height: 20 },
            ),
        ).toEqual([1500, 1501, 1502]);
        expect(
            gridIndicesInContentMarquee(
                6,
                2,
                110,
                100,
                4,
                10,
                { x: 0, y: 5000, width: 400, height: 20 },
            ),
        ).toEqual([]);
    });
});
