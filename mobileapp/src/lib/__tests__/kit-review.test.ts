import { beforeEach, describe, expect, it } from "vitest";
import { markRestReviewNo, markReviewYesThrough } from "@/lib/kit-review";
import { useSelectionStore } from "@/stores/selection-store";

beforeEach(() => {
    useSelectionStore.getState().reset();
});

describe("cycleReviewMark", () => {
    it("cycles none, yes, no, then back to none", () => {
        const { cycleReviewMark } = useSelectionStore.getState();
        cycleReviewMark(1);
        expect(useSelectionStore.getState().reviewMarks.get(1)).toBe("yes");
        cycleReviewMark(1);
        expect(useSelectionStore.getState().reviewMarks.get(1)).toBe("no");
        cycleReviewMark(1);
        expect(useSelectionStore.getState().reviewMarks.has(1)).toBe(false);
    });
});

describe("markReviewMany", () => {
    it("keeps existing no marks", () => {
        const { cycleReviewMark, markReviewMany } = useSelectionStore.getState();
        cycleReviewMark(1);
        cycleReviewMark(1);
        markReviewMany([1, 2], "yes");
        expect([...useSelectionStore.getState().reviewMarks]).toEqual([
            [1, "no"],
            [2, "yes"],
        ]);
    });
});

describe("markReviewYesThrough", () => {
    it("marks only up to and including the tapped photo", () => {
        markReviewYesThrough([10, 11, 12, 13], 12);
        expect([...useSelectionStore.getState().reviewMarks.keys()]).toEqual([
            10, 11, 12,
        ]);
    });
});

describe("markRestReviewNo", () => {
    it("rejects unmarked photos above the lowest mark only", () => {
        const { cycleReviewMark } = useSelectionStore.getState();
        cycleReviewMark(11);
        cycleReviewMark(13);
        markRestReviewNo([10, 11, 12, 13, 14]);
        expect([...useSelectionStore.getState().reviewMarks]).toEqual([
            [11, "yes"],
            [13, "yes"],
            [10, "no"],
            [12, "no"],
        ]);
    });
});

describe("pruneToVisible", () => {
    it("drops review marks on photos that left the view", () => {
        const { cycleReviewMark, pruneToVisible } = useSelectionStore.getState();
        cycleReviewMark(1);
        cycleReviewMark(2);
        pruneToVisible(new Set([2]));
        expect([...useSelectionStore.getState().reviewMarks.keys()]).toEqual([2]);
    });
});

describe("setMode", () => {
    it("clears marks but keeps the review kit", () => {
        const { setReviewKitId, cycleReviewMark, setMode } =
            useSelectionStore.getState();
        setReviewKitId("kit-1");
        cycleReviewMark(1);
        setMode("kitReview");
        expect(useSelectionStore.getState().reviewMarks.size).toBe(0);
        expect(useSelectionStore.getState().reviewKitId).toBe("kit-1");
    });
});
