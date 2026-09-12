import { describe, expect, it } from "vitest";
import {
    DEFAULT_KIT_EMBEDDING_GENOME,
    KIT_NEARNESS_TUNE_VERSION,
    clampKitEmbeddingNearnessGenome,
    parseKitNearnessTuneResult,
} from "@/lib/kit-nearness-embedding-genome";
import {
    buildKitEmbeddingPrototypes,
    evaluateKitEmbeddingGenome,
    mannWhitneyAuc,
    type KitEmbeddingEvalFold,
} from "@/lib/kit-nearness-embedding-eval";

const toEmb = (values: number[]): Float32Array => Float32Array.from(values);
const embMap = (
    entries: Array<[number, number[]]>,
): Map<number, Float32Array> =>
    new Map(entries.map(([id, v]) => [id, toEmb(v)]));

const axis = (dim: number, dims = 512): number[] => {
    const out = new Array(dims).fill(0);
    out[dim] = 1;
    return out;
};

describe("kit-nearness-embedding-genome", () => {
    it("default genome is centroid with S2 rival settings", () => {
        expect(DEFAULT_KIT_EMBEDDING_GENOME.useCentroid).toBe(1);
        expect(DEFAULT_KIT_EMBEDDING_GENOME.rivalLambda).toBe(16);
        expect(DEFAULT_KIT_EMBEDDING_GENOME.rivalTau).toBe(0.02);
    });

    it("clamps and rounds genes", () => {
        const genome = clampKitEmbeddingNearnessGenome({
            rivalTau: 99,
            rivalLambda: -1,
            maxMedoids: 2.7,
            minSeparation: 0.01,
            useCentroid: 0.6,
        });
        expect(genome.rivalTau).toBeLessThanOrEqual(0.4);
        expect(genome.rivalLambda).toBe(0);
        expect(genome.maxMedoids).toBe(3);
        expect(genome.minSeparation).toBe(0.02);
        expect(genome.useCentroid).toBe(1);
    });

    it("parses a valid tune result", () => {
        const parsed = parseKitNearnessTuneResult({
            genome: DEFAULT_KIT_EMBEDDING_GENOME,
            fitness: 0.8,
            holdoutAuc: 0.75,
            holdoutTopK: 0.6,
            baselineFitness: 0.7,
            tunedAt: 1,
            memberCount: 40,
            tuneVersion: KIT_NEARNESS_TUNE_VERSION,
        });
        expect(parsed?.fitness).toBe(0.8);
        expect(parsed?.memberCount).toBe(40);
        expect(parsed?.tuneVersion).toBe(KIT_NEARNESS_TUNE_VERSION);
    });

    it("drops tunes without the current version", () => {
        const parsed = parseKitNearnessTuneResult({
            genome: DEFAULT_KIT_EMBEDDING_GENOME,
            fitness: 0.8,
            holdoutAuc: 0.75,
            holdoutTopK: 0.6,
            baselineFitness: 0.7,
            tunedAt: 1,
            memberCount: 40,
        });
        expect(parsed).toBeUndefined();
    });
});

describe("kit-nearness-embedding-eval", () => {
    it("mannWhitneyAuc is 1 when all positives outrank negatives", () => {
        expect(mannWhitneyAuc([3, 4], [1, 2])).toBe(1);
        expect(mannWhitneyAuc([1, 2], [3, 4])).toBe(0);
    });

    it("scores a coherent kit above chance", () => {
        const embeddings = embMap([
            [1, axis(0)],
            [2, axis(0)],
            [3, axis(0)],
            [4, axis(0)],
            [10, axis(1)],
            [11, axis(1)],
            [12, axis(2)],
            [13, axis(3)],
        ]);
        const fold: KitEmbeddingEvalFold = {
            seedIds: [1, 2],
            holdoutIds: [3, 4],
            negativeIds: [10, 11, 12, 13],
            rivalSeedIdSets: [],
        };
        const breakdown = evaluateKitEmbeddingGenome(
            fold,
            embeddings,
            DEFAULT_KIT_EMBEDDING_GENOME,
        );
        expect(breakdown.holdoutAuc).toBeGreaterThan(0.7);
        expect(breakdown.fitness).toBeGreaterThan(0.6);
    });

    it("buildKitEmbeddingPrototypes respects useCentroid", () => {
        const embeddings = embMap([
            [1, axis(0)],
            [2, axis(0)],
        ]);
        const centroid = buildKitEmbeddingPrototypes(
            [1, 2],
            embeddings,
            { ...DEFAULT_KIT_EMBEDDING_GENOME, useCentroid: 1 },
        );
        expect(centroid).toHaveLength(1);
        const medoids = buildKitEmbeddingPrototypes(
            [1, 2],
            embeddings,
            { ...DEFAULT_KIT_EMBEDDING_GENOME, useCentroid: 0, maxMedoids: 2 },
        );
        expect(medoids.length).toBeGreaterThanOrEqual(1);
    });
});
