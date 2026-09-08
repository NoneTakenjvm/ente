import { describe, expect, it } from "vitest";
import {
    buildCorpusEvalContext,
    DEFAULT_NEARBY_GENOME,
    evaluateNearnessGenome,
    meanPairwisePrimaryDistance,
} from "@/lib/kit-nearness-corpus-eval";
import type { AnonymisedKitNearnessCorpus } from "@/lib/kit-nearness-corpus-export";

const hex = (n: number): string => n.toString(16).padStart(16, "0");

describe("kit-nearness-corpus-eval", () => {
    it("meanPairwisePrimaryDistance is 0 for identical hashes", () => {
        const entries = new Map([
            [1, { hashes: [hex(0)] }],
            [2, { hashes: [hex(0)] }],
            [3, { hashes: [hex(0)] }],
        ]);
        expect(meanPairwisePrimaryDistance([1, 2, 3], entries)).toBe(0);
    });

    it("builds coherent folds and scores default genome above chance", () => {
        const photos = [];
        // Two coherent kits (identical hashes within kit) + distractors
        for (let i = 1; i <= 30; i++) {
            photos.push({
                id: i,
                hashes: [hex(0x1111), hex(0x1111)],
                color: hex(0xaaaa),
                tags: ["t_0001", "t_0002"],
            });
        }
        for (let i = 31; i <= 60; i++) {
            photos.push({
                id: i,
                hashes: [hex(0xffff0000ffff0000), hex(0xffff0000ffff0000)],
                color: hex(0xbbbb),
                tags: ["t_0003", "t_0004"],
            });
        }
        for (let i = 61; i <= 100; i++) {
            photos.push({
                id: i,
                hashes: [hex((i * 0x01010101) & 0xffffffff)],
                color: hex(0xcccc),
                tags: ["t_0005"],
            });
        }
        const corpus = {
            version: 2 as const,
            privacyNotice: "test",
            photos,
            kits: [],
            derivedKits: [
                { id: "d_0001", tags: ["t_0001", "t_0002"], count: 30 },
                { id: "d_0002", tags: ["t_0003", "t_0004"], count: 30 },
            ],
        } as AnonymisedKitNearnessCorpus;
        const ctx = buildCorpusEvalContext(corpus, {
            minCount: 10,
            maxFolds: 4,
            negativePoolSize: 40,
            visualPositiveThreshold: 14,
            minVisualPositives: 3,
        });
        expect(ctx.folds.length).toBeGreaterThanOrEqual(1);
        const score = evaluateNearnessGenome(ctx, DEFAULT_NEARBY_GENOME);
        expect(score.kitCount).toBeGreaterThan(0);
        expect(score.holdoutAuc).toBeGreaterThan(0.7);
        expect(score.fitness).toBeGreaterThan(0.7);
    });
});
