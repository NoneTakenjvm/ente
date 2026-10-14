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
    scanClipNeighbourRow,
    shouldConfirmClipEdge,
    type ClipNeighbour,
} from "@/lib/similarity-clip";
import {
    clusterFromFileEdges,
    runStage1Clustering,
    type Stage1ClipOptions,
    type Stage1Cluster,
    type Stage1FileEdge,
    type Stage1Item,
} from "@/lib/similarity-stage1-core";
import { embMap } from "@/test-utils/fixtures";

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

/** Top-K lists via the same per-row scan the async Stage-1 pass uses. */
const topNeighbours = (
    vectors: readonly number[][],
    topK: number,
): ClipNeighbour[][] => {
    const topByIndex: ClipNeighbour[][] = vectors.map(() => []);
    for (let row = 0; row < vectors.length; row++) {
        scanClipNeighbourRow(
            vectors,
            row,
            topByIndex,
            topK,
            CLIP_SCORE_COLLECT_MAX,
        );
    }
    return topByIndex;
};

/** Production Stage-1 (what the phash worker runs), clusters only. */
const clusterStage1 = async (
    items: Stage1Item[],
    threshold: number,
    clip?: Stage1ClipOptions,
): Promise<Stage1Cluster[]> =>
    (
        await runStage1Clustering(
            items,
            threshold,
            () => {},
            undefined,
            undefined,
            clip,
        )
    ).clusters;

describe("scanClipNeighbourRow + confirm", () => {
    it("links near neighbours and skips far ones", () => {
        const [a, b] = nearPair();
        const far = [0, 1];
        const top = topNeighbours([a, b, far], 3);
        const edges = collectConfirmedClipEdges(top);
        expect(edges.some((e) => e.left === 0 && e.right === 1)).toBe(true);
        expect(edges.some((e) => e.left === 0 && e.right === 2)).toBe(false);
    });

    it("keeps asymmetric 1-NN edges (closest relative)", () => {
        // A → B closest; B → C closest (A not mutual with B).
        const a = [1, 0];
        const b = [0.99, Math.sqrt(1 - 0.99 ** 2)];
        const c = [0.985, Math.sqrt(1 - 0.985 ** 2)];
        const top = topNeighbours([a, b, c], 3);
        expect(top[0]![0]?.other).toBe(1);
        expect(top[1]![0]?.other).toBe(2);
        const edges = collectConfirmedClipEdges(top);
        expect(edges.some((e) => e.left === 0 && e.right === 1)).toBe(true);
        expect(edges.some((e) => e.left === 1 && e.right === 2)).toBe(true);
    });
});

describe("runStage1Clustering CLIP-first", () => {
    const items: Stage1Item[] = [
        { fileId: 1, hashes: ["aaaaaaaaaaaaaaaa"] },
        { fileId: 2, hashes: ["bbbbbbbbbbbbbbbb"] },
        { fileId: 3, hashes: ["cccccccccccccccc"] },
    ];

    it("groups CLIP-near files even when hashes differ", async () => {
        const [a, b] = nearPair();
        const embeddings = embMap([
            [1, a],
            [2, b],
            [3, [0, 1]],
        ]);
        const clusters = await clusterStage1(items, CLIP_SCORE_SLIDER_MAX, {
            embeddings,
        });
        expect(clusters).toHaveLength(1);
        expect(clusters[0]!.fileIds.sort()).toEqual([1, 2]);
    });

    it("does not group orthogonal embeddings", async () => {
        const embeddings = embMap([
            [1, [1, 0]],
            [2, [0, 1]],
        ]);
        const clusters = await clusterStage1(items.slice(0, 2), 12, {
            embeddings,
        });
        expect(clusters).toEqual([]);
    });

    it("groups near-identical hashes even when CLIP disagrees", async () => {
        const twins: Stage1Item[] = [
            { fileId: 1, hashes: ["aaaaaaaaaaaaaaaa"] },
            { fileId: 2, hashes: ["aaaaaaaaaaaaaaab"] },
        ];
        const embeddings = embMap([
            [1, [1, 0, 0, 0]],
            [2, [0, 1, 0, 0]],
        ]);
        const clusters = await clusterStage1(twins, CLIP_SCORE_SLIDER_MIN, {
            embeddings,
        });
        expect(clusters).toHaveLength(1);
        expect(clusters[0]!.fileIds.sort()).toEqual([1, 2]);
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
        const embeddings = embMap([
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

describe("runStage1Clustering without CLIP", () => {
    it("still groups identical hashes", async () => {
        const items: Stage1Item[] = [
            { fileId: 1, hashes: ["aaaaaaaaaaaaaaaa"] },
            { fileId: 2, hashes: ["aaaaaaaaaaaaaaaa"] },
        ];
        const clusters = await clusterStage1(items, 8);
        expect(clusters).toHaveLength(1);
        expect(clusters[0]!.fileIds.sort()).toEqual([1, 2]);
    });
});
