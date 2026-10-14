import { describe, expect, it } from "vitest";
import { sortFilesByTagFilterFit } from "@/lib/tag-filter-fit-sort";
import { axis, bareFile, embMap } from "@/test-utils/fixtures";

describe("sortFilesByTagFilterFit", () => {
    it("returns a copy for none / tiny sets", () => {
        const files = [bareFile(1)];
        expect(sortFilesByTagFilterFit(files, "none", new Map())).toEqual(
            files,
        );
        expect(sortFilesByTagFilterFit(files, "best", new Map())).toEqual(
            files,
        );
    });

    it("orders best = closest to medoids first", () => {
        // Two near axis-0, one on axis-1 (outlier — not dense enough to be a medoid).
        const embeddings = embMap([
            [1, axis(0)],
            [2, axis(0)],
            [3, axis(1)],
        ]);
        const ordered = sortFilesByTagFilterFit(
            [bareFile(3), bareFile(1), bareFile(2)],
            "best",
            embeddings,
        );
        expect(ordered.map((f) => f.id).at(-1)).toBe(3);
        expect(new Set(ordered.map((f) => f.id).slice(0, 2))).toEqual(
            new Set([1, 2]),
        );
    });

    it("orders worst = farthest from medoids first", () => {
        const embeddings = embMap([
            [1, axis(0)],
            [2, axis(0)],
            [3, axis(1)],
        ]);
        const ordered = sortFilesByTagFilterFit(
            [bareFile(1), bareFile(2), bareFile(3)],
            "worst",
            embeddings,
        );
        expect(ordered.map((f) => f.id)[0]).toBe(3);
    });

    it("puts missing embeddings last for best", () => {
        const embeddings = embMap([
            [1, axis(0)],
            [2, axis(0)],
        ]);
        const ordered = sortFilesByTagFilterFit(
            [bareFile(9), bareFile(1), bareFile(2)],
            "best",
            embeddings,
        );
        expect(ordered.map((f) => f.id).at(-1)).toBe(9);
    });
});
