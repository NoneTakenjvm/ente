import { describe, expect, it } from "vitest";
import { sortFilesByRelative } from "@/lib/relative-sort";
import {
    pickRelativeStartIndex,
    sortIdsByRelativePacked,
} from "@/lib/relative-sort-packed";
import { axis, bareFile, embMap } from "@/test-utils/fixtures";

/** Unit vector on one axis of a 512-d space. */
/** L2-normalize a vector (copy). */
const normalize = (vector: number[]): number[] => {
    let sumSquares = 0;
    for (const value of vector) {
        sumSquares += value * value;
    }
    const scale = Math.sqrt(sumSquares);
    return vector.map((value) => value / scale);
};

/** Blend of axis-0 and axis-1, L2-normalized (weight on axis-1). */
const blend01 = (axis1Weight: number): number[] => {
    const out = new Array(512).fill(0);
    out[0] = 1;
    out[1] = axis1Weight;
    return normalize(out);
};

/** First seed whose deterministic start pick over `ids` is `startId`. */
const seedForStartId = (ids: readonly number[], startId: number): number => {
    for (let seed = 0; seed <= 10_000; seed += 1) {
        if (ids[pickRelativeStartIndex(ids, seed)] === startId) {
            return seed;
        }
    }
    throw new Error(`could not find seed for start id ${startId}`);
};

describe("sortFilesByRelative", () => {
    it("returns a copy for none / tiny sets", () => {
        const files = [bareFile(1)];
        expect(sortFilesByRelative(files, "none", new Map(), 1)).toEqual(
            files,
        );
        expect(sortFilesByRelative(files, "closest", new Map(), 1)).toEqual(
            files,
        );
    });

    it("walks a genuine closest path A→B→C→D along a line", () => {
        // Distances: AB < AC < AD; BC < BD — greedy closest from A is A-B-C-D.
        const embeddings = embMap([
            [1, axis(0)],
            [2, blend01(0.4)],
            [3, blend01(1)],
            [4, axis(1)],
        ]);
        const seed = seedForStartId([1, 2, 3, 4], 1);
        const ordered = sortFilesByRelative(
            [bareFile(4), bareFile(3), bareFile(2), bareFile(1)],
            "closest",
            embeddings,
            seed,
        );
        expect(ordered.map((f) => f.id)).toEqual([1, 2, 3, 4]);
    });

    it("walks furthest as the opposite greedy path from the same start", () => {
        const embeddings = embMap([
            [1, axis(0)],
            [2, blend01(0.4)],
            [3, blend01(1)],
            [4, axis(1)],
        ]);
        const seed = seedForStartId([1, 2, 3, 4], 1);
        // From A: furthest is D; from D among {B,C}: B is farther → A-D-B-C.
        const ordered = sortFilesByRelative(
            [bareFile(1), bareFile(2), bareFile(3), bareFile(4)],
            "furthest",
            embeddings,
            seed,
        );
        expect(ordered.map((f) => f.id)).toEqual([1, 4, 2, 3]);
    });

    it("is a permutation of the input (no drops / duplicates)", () => {
        const embeddings = embMap([
            [1, axis(0)],
            [2, blend01(0.4)],
            [3, axis(1)],
            [9, axis(2)],
        ]);
        const files = [bareFile(9), bareFile(1), bareFile(3), bareFile(2)];
        const ordered = sortFilesByRelative(files, "closest", embeddings, 7);
        expect(ordered.map((f) => f.id).sort((a, b) => a - b)).toEqual([
            1, 2, 3, 9,
        ]);
        expect(new Set(ordered.map((f) => f.id)).size).toBe(4);
    });

    it("uses an explicit startFileId as the chain tip", () => {
        const embeddings = embMap([
            [1, axis(0)],
            [2, blend01(0.4)],
            [3, blend01(1)],
            [4, axis(1)],
        ]);
        const ordered = sortFilesByRelative(
            [bareFile(1), bareFile(2), bareFile(3), bareFile(4)],
            "closest",
            embeddings,
            0,
            4,
        );
        expect(ordered.map((f) => f.id)[0]).toBe(4);
    });

    it("ranks every file against startFileId instead of chaining", () => {
        const vector = (x: number, y: number, z: number): number[] => {
            const out = new Array(512).fill(0);
            out[0] = x;
            out[1] = y;
            out[2] = z;
            return normalize(out);
        };
        // Similarity to 1: 2 → 0.8, 4 → 0.3, 3 → 0. A chain would go 1,2,3,4
        // because 3 is closer to 2 than 4 is.
        const embeddings = embMap([
            [1, vector(1, 0, 0)],
            [2, vector(0.8, 0, 0.6)],
            [3, vector(0, 0, 1)],
            [4, vector(0.3, 0.954, 0)],
        ]);
        const ordered = sortFilesByRelative(
            [bareFile(4), bareFile(3), bareFile(2), bareFile(1)],
            "closest",
            embeddings,
            0,
            1,
        );
        expect(ordered.map((f) => f.id)).toEqual([1, 2, 4, 3]);
    });

    it("falls back to seed when startFileId is missing an embedding", () => {
        const embeddings = embMap([
            [1, axis(0)],
            [2, axis(1)],
        ]);
        const seed = seedForStartId([1, 2], 1);
        const ordered = sortFilesByRelative(
            [bareFile(1), bareFile(2), bareFile(9)],
            "closest",
            embeddings,
            seed,
            9,
        );
        expect(ordered.map((f) => f.id).slice(0, 2)).toEqual([1, 2]);
    });
});

describe("sortIdsByRelativePacked", () => {
    it("matches sortFilesByRelative order for a closest line", () => {
        const embeddings = embMap([
            [1, axis(0)],
            [2, blend01(0.4)],
            [3, blend01(1)],
            [4, axis(1)],
        ]);
        const ids = [1, 2, 3, 4];
        const packed = new Float32Array(ids.length * 512);
        for (let index = 0; index < ids.length; index += 1) {
            packed.set(embeddings.get(ids[index]!)!, index * 512);
        }
        const ordered = sortIdsByRelativePacked(
            ids,
            packed,
            512,
            "closest",
            0,
            1,
        );
        expect(ordered).toEqual([1, 2, 3, 4]);
    });

    it("preserves Ente-scale file ids that do not fit in Int32", () => {
        const ids = [2_500_000_001, 2_500_000_002, 2_500_000_003, 2_500_000_004];
        const embeddings = embMap([
            [ids[0]!, axis(0)],
            [ids[1]!, blend01(0.4)],
            [ids[2]!, blend01(1)],
            [ids[3]!, axis(1)],
        ]);
        const packed = new Float32Array(ids.length * 512);
        for (let index = 0; index < ids.length; index += 1) {
            packed.set(embeddings.get(ids[index]!)!, index * 512);
        }
        // Float64 round-trip (worker id buffer) must not truncate.
        const transferred = Float64Array.from(ids);
        expect([...transferred]).toEqual(ids);
        expect([...Int32Array.from(ids)]).not.toEqual(ids);

        const ordered = sortIdsByRelativePacked(
            [...transferred],
            packed,
            512,
            "closest",
            0,
            ids[0],
        );
        expect(ordered[0]).toBe(ids[0]);
        expect(new Set(ordered)).toEqual(new Set(ids));
    });
});
