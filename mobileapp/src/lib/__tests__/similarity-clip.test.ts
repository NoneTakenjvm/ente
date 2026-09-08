import { describe, expect, it } from "vitest";
import {
    CLIP_SCORE_COLLECT_MAX,
    CLIP_SCORE_SLIDER_MAX,
    CLIP_SCORE_SLIDER_MIN,
    CLIP_TIGHT_SCORE,
    clampClipScoreThreshold,
    clipDistanceToScore,
    collectConfirmedClipEdges,
    embeddingCosineDistance,
    findClipTopNeighbours,
    shouldConfirmClipEdge,
} from "@/lib/similarity-clip";
import {
    clusterFromFileEdges,
    runStage1ClusteringSync,
    type Stage1FileEdge,
    type Stage1Item,
} from "@/lib/similarity-stage1-core";

const unit = (value: number, dim = 4): number[] => {
    const v = new Array(dim).fill(0);
    v[0] = value;
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
};

/** Two close-but-not-identical directions in 2D. */
const nearPair = (): [number[], number[]] => {
    const a = [1, 0];
    const b = [0.995, Math.sqrt(1 - 0.995 ** 2)];
    return [a, b];
};

describe("embeddingCosineDistance", () => {
    it("is 0 for identical vectors", () => {
        const a = unit(1);
        expect(embeddingCosineDistance(a, a)).toBeCloseTo(0, 5);
    });

    it("is large for orthogonal-ish vectors", () => {
        const a = [1, 0, 0, 0];
        const b = [0, 1, 0, 0];
        expect(embeddingCosineDistance(a, b)).toBeCloseTo(1, 5);
    });
});

describe("clipDistanceToScore / clamp", () => {
    it("maps cosine to slider score", () => {
        expect(clipDistanceToScore(0.12)).toBe(12);
        expect(clipDistanceToScore(0.084)).toBe(8);
    });

    it("clamps into the Similar slider range", () => {
        expect(clampClipScoreThreshold(4)).toBe(CLIP_SCORE_SLIDER_MIN);
        expect(clampClipScoreThreshold(20)).toBe(CLIP_SCORE_SLIDER_MAX);
        expect(clampClipScoreThreshold(12)).toBe(12);
    });
});

describe("shouldConfirmClipEdge", () => {
    it("always confirms tight scores", () => {
        expect(
            shouldConfirmClipEdge([], [], 0, 1, CLIP_TIGHT_SCORE),
        ).toBe(true);
    });

    it("requires mutual top-K for looser scores", () => {
        const leftTop = [{ other: 1, score: 10 }];
        const rightTop = [{ other: 0, score: 10 }];
        expect(shouldConfirmClipEdge(leftTop, rightTop, 0, 1, 10)).toBe(true);
        expect(shouldConfirmClipEdge(leftTop, [], 0, 1, 10)).toBe(false);
    });
});

describe("findClipTopNeighbours + confirm", () => {
    it("links near neighbours and skips far ones", () => {
        const [a, b] = nearPair();
        const far = [0, 1];
        const top = findClipTopNeighbours(
            [a, b, far],
            3,
            CLIP_SCORE_COLLECT_MAX,
        );
        const edges = collectConfirmedClipEdges(top);
        expect(edges.some((e) => e.left === 0 && e.right === 1)).toBe(true);
        expect(edges.some((e) => e.left === 0 && e.right === 2)).toBe(false);
    });

    it("keeps asymmetric 1-NN edges (closest relative)", () => {
        // A → B closest; B → C closest (A not mutual with B).
        const a = [1, 0];
        const b = [0.99, Math.sqrt(1 - 0.99 ** 2)];
        const c = [0.985, Math.sqrt(1 - 0.985 ** 2)];
        const top = findClipTopNeighbours([a, b, c], 3, CLIP_SCORE_COLLECT_MAX);
        expect(top[0]![0]?.other).toBe(1);
        expect(top[1]![0]?.other).toBe(2);
        const edges = collectConfirmedClipEdges(top);
        expect(edges.some((e) => e.left === 0 && e.right === 1)).toBe(true);
        expect(edges.some((e) => e.left === 1 && e.right === 2)).toBe(true);
    });
});

describe("runStage1ClusteringSync CLIP-first", () => {
    const items: Stage1Item[] = [
        { fileId: 1, hashes: ["aaaaaaaaaaaaaaaa"] },
        { fileId: 2, hashes: ["bbbbbbbbbbbbbbbb"] },
        { fileId: 3, hashes: ["cccccccccccccccc"] },
    ];

    it("groups CLIP-near files even when hashes differ", () => {
        const [a, b] = nearPair();
        const embeddings = new Map<number, number[]>([
            [1, a],
            [2, b],
            [3, [0, 1]],
        ]);
        const clusters = runStage1ClusteringSync(items, CLIP_SCORE_SLIDER_MAX, {
            embeddings,
        });
        expect(clusters).toHaveLength(1);
        expect(clusters[0]!.fileIds.sort()).toEqual([1, 2]);
    });

    it("does not group orthogonal embeddings", () => {
        const embeddings = new Map<number, number[]>([
            [1, [1, 0]],
            [2, [0, 1]],
        ]);
        const clusters = runStage1ClusteringSync(items.slice(0, 2), 12, {
            embeddings,
        });
        expect(clusters).toEqual([]);
    });
});

describe("clusterFromFileEdges CLIP scores", () => {
    const items: Stage1Item[] = [
        { fileId: 1, hashes: ["aaaaaaaaaaaaaaaa"] },
        { fileId: 2, hashes: ["bbbbbbbbbbbbbbbb"] },
    ];

    it("filters by CLIP score threshold", () => {
        const edges: Stage1FileEdge[] = [
            { leftFileId: 1, rightFileId: 2, distance: 10 },
        ];
        const embeddings = new Map<number, number[]>([
            [1, unit(1)],
            [2, unit(1)],
        ]);
        expect(
            clusterFromFileEdges(items, edges, 8, { embeddings }),
        ).toEqual([]);
        const at10 = clusterFromFileEdges(items, edges, 10, { embeddings });
        expect(at10).toHaveLength(1);
        expect(at10[0]!.fileIds.sort()).toEqual([1, 2]);
    });
});

describe("runStage1ClusteringSync without CLIP", () => {
    it("still groups identical hashes", () => {
        const items: Stage1Item[] = [
            { fileId: 1, hashes: ["aaaaaaaaaaaaaaaa"] },
            { fileId: 2, hashes: ["aaaaaaaaaaaaaaaa"] },
        ];
        const clusters = runStage1ClusteringSync(items, 8);
        expect(clusters).toHaveLength(1);
        expect(clusters[0]!.fileIds.sort()).toEqual([1, 2]);
    });
});
