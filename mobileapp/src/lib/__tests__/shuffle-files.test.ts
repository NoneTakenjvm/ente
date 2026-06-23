import { describe, expect, it } from "vitest";
import { reconcileShuffledIds, shuffleIds } from "@/lib/shuffle-files";
describe("reconcileShuffledIds", () => {
    it("preserves relative order when files are removed", () => {
        const seed = 42;
        const initial = shuffleIds([1, 2, 3, 4, 5], seed);
        const remainingIds = new Set([1, 3, 5]);
        const reconciled = reconcileShuffledIds([1, 3, 5], seed, initial);
        const expectedOrder = initial.filter((id) => remainingIds.has(id));
        expect(reconciled).toEqual(expectedOrder);
    });

    it("appends newly added files without reordering existing ones", () => {
        const seed = 7;
        const initial = shuffleIds([1, 2, 3], seed);
        const reconciled = reconcileShuffledIds([1, 2, 3, 4, 5], seed, initial);
        expect(reconciled.slice(0, 3)).toEqual(initial);
        expect([...reconciled].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });

    it("fully shuffles when no previous order is provided", () => {
        const ids = [1, 2, 3, 4];
        const shuffled = reconcileShuffledIds(ids, 99);
        expect([...shuffled].sort((a, b) => a - b)).toEqual(ids);
        expect(shuffled).not.toEqual(ids);
    });
});
