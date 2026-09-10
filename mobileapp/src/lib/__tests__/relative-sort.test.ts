import { describe, expect, it } from "vitest";
import {
    pickRelativeStartId,
    sortFilesByRelative,
} from "@/lib/relative-sort";
import { sortIdsByRelativePacked } from "@/lib/relative-sort-packed";
import type { EnteFile } from "ente-media/file";

const file = (id: number): EnteFile => ({ id }) as EnteFile;

/** Unit vector on one axis of a 512-d space. */
const axis = (dim: number, dims = 512): number[] => {
    const out = new Array(dims).fill(0);
    out[dim] = 1;
    return out;
};

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

describe("pickRelativeStartId", () => {
    it("returns an id from the list", () => {
        const ids = [10, 20, 30];
        expect(ids).toContain(pickRelativeStartId(ids, 1));
    });

    it("is deterministic for a fixed seed", () => {
        const ids = [1, 2, 3, 4, 5];
        expect(pickRelativeStartId(ids, 42)).toBe(pickRelativeStartId(ids, 42));
    });
});

describe("sortFilesByRelative", () => {
    it("returns a copy for none / tiny sets", () => {
        const files = [file(1)];
        expect(sortFilesByRelative(files, "none", new Map(), 1)).toEqual(
            files,
        );
        expect(sortFilesByRelative(files, "closest", new Map(), 1)).toEqual(
            files,
        );
    });

    it("walks a genuine closest path A→B→C→D along a line", () => {
        // Distances: AB < AC < AD; BC < BD — greedy closest from A is A-B-C-D.
        const embeddings = new Map([
            [1, axis(0)],
            [2, blend01(0.4)],
            [3, blend01(1)],
            [4, axis(1)],
        ]);
        let seed = 0;
        while (pickRelativeStartId([1, 2, 3, 4], seed) !== 1) {
            seed += 1;
            if (seed > 10_000) {
                throw new Error("could not find seed for start id 1");
            }
        }
        const ordered = sortFilesByRelative(
            [file(4), file(3), file(2), file(1)],
            "closest",
            embeddings,
            seed,
        );
        expect(ordered.map((f) => f.id)).toEqual([1, 2, 3, 4]);
    });

    it("walks furthest as the opposite greedy path from the same start", () => {
        const embeddings = new Map([
            [1, axis(0)],
            [2, blend01(0.4)],
            [3, blend01(1)],
            [4, axis(1)],
        ]);
        let seed = 0;
        while (pickRelativeStartId([1, 2, 3, 4], seed) !== 1) {
            seed += 1;
            if (seed > 10_000) {
                throw new Error("could not find seed for start id 1");
            }
        }
        // From A: furthest is D; from D among {B,C}: B is farther → A-D-B-C.
        const ordered = sortFilesByRelative(
            [file(1), file(2), file(3), file(4)],
            "furthest",
            embeddings,
            seed,
        );
        expect(ordered.map((f) => f.id)).toEqual([1, 4, 2, 3]);
    });

    it("is a permutation of the input (no drops / duplicates)", () => {
        const embeddings = new Map([
            [1, axis(0)],
            [2, blend01(0.4)],
            [3, axis(1)],
            [9, axis(2)],
        ]);
        const files = [file(9), file(1), file(3), file(2)];
        const ordered = sortFilesByRelative(files, "closest", embeddings, 7);
        expect(ordered.map((f) => f.id).sort((a, b) => a - b)).toEqual([
            1, 2, 3, 9,
        ]);
        expect(new Set(ordered.map((f) => f.id)).size).toBe(4);
    });

    it("uses an explicit startFileId as the chain tip", () => {
        const embeddings = new Map([
            [1, axis(0)],
            [2, blend01(0.4)],
            [3, blend01(1)],
            [4, axis(1)],
        ]);
        const ordered = sortFilesByRelative(
            [file(1), file(2), file(3), file(4)],
            "closest",
            embeddings,
            0,
            4,
        );
        expect(ordered.map((f) => f.id)[0]).toBe(4);
    });

    it("falls back to seed when startFileId is missing an embedding", () => {
        const embeddings = new Map([
            [1, axis(0)],
            [2, axis(1)],
        ]);
        let seed = 0;
        while (pickRelativeStartId([1, 2], seed) !== 1) {
            seed += 1;
            if (seed > 10_000) {
                throw new Error("could not find seed for start id 1");
            }
        }
        const ordered = sortFilesByRelative(
            [file(1), file(2), file(9)],
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
        const embeddings = new Map([
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
        const embeddings = new Map([
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
