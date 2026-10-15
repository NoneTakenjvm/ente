import { describe, expect, it } from "vitest";
import {
    CLIP_SCORE_SLIDER_MAX,
    CLIP_SCORE_SLIDER_MIN,
    clampClipScoreThreshold,
    clipDistanceToScore,
    collectClipPairs,
    embeddingCosineDistance,
    groupClipPairs,
    type ClipPairs,
} from "@/lib/similarity-clip";

/** Unit vector in 2D at cosine distance `distance` from [1, 0]. */
const atDistance = (distance: number): number[] => {
    const dot = 1 - distance;
    return [dot, Math.sqrt(1 - dot * dot)];
};

const toPairs = (rows: Array<[number, number, number]>): ClipPairs => ({
    leftIds: Float64Array.from(rows.map(([left]) => left)),
    rightIds: Float64Array.from(rows.map(([, right]) => right)),
    scores: Uint8Array.from(rows.map(([, , score]) => score)),
});

const everyFile = (): boolean => true;

describe("embeddingCosineDistance", () => {
    it("is 0 for identical vectors and 1 for orthogonal ones", () => {
        expect(embeddingCosineDistance([1, 0], [1, 0])).toBeCloseTo(0);
        expect(embeddingCosineDistance([1, 0], [0, 1])).toBeCloseTo(1);
    });

    it("is Infinity for mismatched lengths", () => {
        expect(embeddingCosineDistance([1, 0], [1])).toBe(
            Number.POSITIVE_INFINITY,
        );
    });
});

describe("clipDistanceToScore / clamp", () => {
    it("maps cosine distance to slider score", () => {
        expect(clipDistanceToScore(0.123)).toBe(12);
        expect(clipDistanceToScore(-0.01)).toBe(0);
    });

    it("clamps into the Similar slider range", () => {
        expect(clampClipScoreThreshold(0)).toBe(CLIP_SCORE_SLIDER_MIN);
        expect(clampClipScoreThreshold(99)).toBe(CLIP_SCORE_SLIDER_MAX);
    });
});

describe("collectClipPairs", () => {
    it("keeps pairs within maxScore and drops the rest", () => {
        const vectors = [[1, 0], atDistance(0.05), [0, 1]];
        const packed = Float32Array.from(vectors.flat());
        const pairs = collectClipPairs([10, 20, 30], packed, 2, 25);
        expect([...pairs.leftIds]).toEqual([10]);
        expect([...pairs.rightIds]).toEqual([20]);
        expect([...pairs.scores]).toEqual([5]);
        expect(collectClipPairs([10, 20, 30], packed, 2, 4).scores).toHaveLength(0);
    });

    it("reports each finished row", () => {
        const packed = Float32Array.from([1, 0, 1, 0, 1, 0]);
        const rows: number[] = [];
        collectClipPairs([1, 2, 3], packed, 2, 25, (completed) => rows.push(completed));
        expect(rows).toEqual([1, 2, 3]);
    });
});

describe("groupClipPairs", () => {
    it("does not chain files that are not all within the threshold", () => {
        const pairs = toPairs([
            [1, 2, 5],
            [2, 3, 10],
            [3, 4, 5],
        ]);
        expect(groupClipPairs(pairs, 12, everyFile)).toEqual([
            [1, 2],
            [3, 4],
        ]);
    });

    it("keeps a large all-close pile together with no size cap", () => {
        const rows: Array<[number, number, number]> = [];
        for (let left = 1; left <= 8; left++) {
            for (let right = left + 1; right <= 8; right++) {
                rows.push([left, right, 3]);
            }
        }
        const groups = groupClipPairs(toPairs(rows), 12, everyFile);
        expect(groups).toHaveLength(1);
        expect([...groups[0]!].sort((a, b) => a - b)).toEqual([
            1, 2, 3, 4, 5, 6, 7, 8,
        ]);
    });

    it("ignores pairs above the threshold", () => {
        const pairs = toPairs([[1, 2, 13]]);
        expect(groupClipPairs(pairs, 12, everyFile)).toEqual([]);
    });

    it("drops files that are no longer live", () => {
        const pairs = toPairs([
            [1, 2, 3],
            [1, 3, 4],
            [2, 3, 4],
        ]);
        expect(groupClipPairs(pairs, 12, (fileId) => fileId !== 2)).toEqual([
            [1, 3],
        ]);
    });

    it("lists groups tightest pair first", () => {
        const pairs = toPairs([
            [1, 2, 9],
            [3, 4, 2],
        ]);
        expect(groupClipPairs(pairs, 12, everyFile)).toEqual([
            [3, 4],
            [1, 2],
        ]);
    });
});
