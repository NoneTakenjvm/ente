import { describe, expect, it } from "vitest";
import {
    DEFAULT_SIMILAR_CLIP_KNOBS,
    embeddingCosineDistance,
    shouldKeepStage1Edge,
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

describe("shouldKeepStage1Edge", () => {
    const knobs = DEFAULT_SIMILAR_CLIP_KNOBS;

    it("keeps dHash-only edges within threshold when CLIP missing", () => {
        expect(shouldKeepStage1Edge(6, undefined, 8, knobs)).toBe(true);
        expect(shouldKeepStage1Edge(10, undefined, 8, knobs)).toBe(false);
    });

    it("always keeps near-exact Hamming", () => {
        expect(shouldKeepStage1Edge(1, 0.9, 8, knobs)).toBe(true);
    });

    it("gates mid-band dHash when CLIP is far", () => {
        expect(shouldKeepStage1Edge(6, 0.5, 8, knobs)).toBe(false);
    });

    it("keeps mid-band dHash when CLIP is within gate", () => {
        expect(shouldKeepStage1Edge(6, 0.2, 8, knobs)).toBe(true);
    });

    it("rescues above-threshold Hamming when CLIP is very close", () => {
        expect(shouldKeepStage1Edge(12, 0.05, 8, knobs)).toBe(true);
        expect(shouldKeepStage1Edge(12, 0.5, 8, knobs)).toBe(false);
    });
});

describe("clusterFromFileEdges with CLIP", () => {
    const items: Stage1Item[] = [
        { fileId: 1, hashes: ["aaaaaaaaaaaaaaaa"] },
        { fileId: 2, hashes: ["aaaaaaaaaaaaaaaa"] },
        { fileId: 3, hashes: ["aaaaaaaaaaaaaaab"] }, // ~1 bit — tight-ish
    ];

    it("drops a mid-band edge that is far in CLIP", () => {
        const edges: Stage1FileEdge[] = [
            { leftFileId: 1, rightFileId: 2, distance: 6 },
        ];
        const embeddings = new Map<number, number[]>([
            [1, unit(1)],
            [2, [0, 1, 0, 0]],
        ]);
        const clusters = clusterFromFileEdges(items.slice(0, 2), edges, 8, {
            embeddings,
        });
        expect(clusters).toEqual([]);
    });

    it("rescues a high-Hamming CLIP-near pair", () => {
        const edges: Stage1FileEdge[] = [
            { leftFileId: 1, rightFileId: 2, distance: 12 },
        ];
        const embeddings = new Map<number, number[]>([
            [1, unit(1)],
            [2, unit(1)],
        ]);
        const clusters = clusterFromFileEdges(items.slice(0, 2), edges, 8, {
            embeddings,
        });
        expect(clusters).toHaveLength(1);
        expect(clusters[0]!.fileIds.sort()).toEqual([1, 2]);
    });

    it("force-unions CLIP rescue even when mutual-kNN would drop it", () => {
        // Many tight hash neighbours for 1 and 2; rescue edge 1–99 is Hamming-far.
        const many: Stage1Item[] = [
            { fileId: 1, hashes: ["aaaaaaaaaaaaaaaa"] },
            { fileId: 2, hashes: ["aaaaaaaaaaaaaaaa"] },
            { fileId: 99, hashes: ["aaaaaaaaaaaaaaaa"] },
        ];
        for (let i = 0; i < 10; i++) {
            many.push({
                fileId: 10 + i,
                hashes: ["aaaaaaaaaaaaaaaa"],
            });
        }
        const edges: Stage1FileEdge[] = [
            { leftFileId: 1, rightFileId: 99, distance: 14 },
        ];
        for (let i = 0; i < 10; i++) {
            edges.push({
                leftFileId: 1,
                rightFileId: 10 + i,
                distance: 1,
            });
            edges.push({
                leftFileId: 99,
                rightFileId: 10 + i,
                distance: 1,
            });
        }
        const embeddings = new Map<number, number[]>();
        embeddings.set(1, unit(1));
        embeddings.set(99, unit(1));
        for (let i = 0; i < 10; i++) {
            embeddings.set(10 + i, [0, 1, 0, 0]);
        }
        const clusters = clusterFromFileEdges(many, edges, 8, { embeddings });
        const withRescue = clusters.find((c) =>
            c.fileIds.includes(1) && c.fileIds.includes(99));
        expect(withRescue).toBeDefined();
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
