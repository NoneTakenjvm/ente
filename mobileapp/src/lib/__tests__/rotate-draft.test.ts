import { describe, expect, it } from "vitest";
import {
    nextPendingRotation,
    previewTransformForRotation,
} from "@/lib/rotate-draft";

describe("nextPendingRotation", () => {
    it("cycles 90 → 180 → 270 → clear", () => {
        expect(nextPendingRotation(undefined)).toBe(90);
        expect(nextPendingRotation(90)).toBe(180);
        expect(nextPendingRotation(180)).toBe(270);
        expect(nextPendingRotation(270)).toBeUndefined();
    });
});

describe("previewTransformForRotation", () => {
    it("returns undefined for 0°", () => {
        expect(previewTransformForRotation(0, 100, 100)).toBeUndefined();
    });

    it("scales 90° to fit a non-square cell", () => {
        expect(previewTransformForRotation(90, 200, 100)).toBe(
            "rotate(90deg) scale(0.5)",
        );
    });

    it("only rotates 180°", () => {
        expect(previewTransformForRotation(180, 200, 100)).toBe(
            "rotate(180deg)",
        );
    });
});
