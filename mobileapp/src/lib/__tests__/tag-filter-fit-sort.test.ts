import { describe, expect, it } from "vitest";
import { sortFilesByTagFilterFit } from "@/lib/tag-filter-fit-sort";
import type { EnteFile } from "ente-media/file";

const file = (id: number): EnteFile => ({ id }) as EnteFile;

const axis = (dim: number, dims = 512): number[] => {
    const out = new Array(dims).fill(0);
    out[dim] = 1;
    return out;
};

describe("sortFilesByTagFilterFit", () => {
    it("returns a copy for none / tiny sets", () => {
        const files = [file(1)];
        expect(sortFilesByTagFilterFit(files, "none", new Map())).toEqual(
            files,
        );
        expect(sortFilesByTagFilterFit(files, "best", new Map())).toEqual(
            files,
        );
    });

    it("orders best = closest to medoids first", () => {
        // Two near axis-0, one on axis-1 (outlier — not dense enough to be a medoid).
        const embeddings = new Map([
            [1, axis(0)],
            [2, axis(0)],
            [3, axis(1)],
        ]);
        const ordered = sortFilesByTagFilterFit(
            [file(3), file(1), file(2)],
            "best",
            embeddings,
        );
        expect(ordered.map((f) => f.id).at(-1)).toBe(3);
        expect(new Set(ordered.map((f) => f.id).slice(0, 2))).toEqual(
            new Set([1, 2]),
        );
    });

    it("orders worst = farthest from medoids first", () => {
        const embeddings = new Map([
            [1, axis(0)],
            [2, axis(0)],
            [3, axis(1)],
        ]);
        const ordered = sortFilesByTagFilterFit(
            [file(1), file(2), file(3)],
            "worst",
            embeddings,
        );
        expect(ordered.map((f) => f.id)[0]).toBe(3);
    });

    it("puts missing embeddings last for best", () => {
        const embeddings = new Map([
            [1, axis(0)],
            [2, axis(0)],
        ]);
        const ordered = sortFilesByTagFilterFit(
            [file(9), file(1), file(2)],
            "best",
            embeddings,
        );
        expect(ordered.map((f) => f.id).at(-1)).toBe(9);
    });
});
