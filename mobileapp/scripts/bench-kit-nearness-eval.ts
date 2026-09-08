/**
 * Micro-benchmark: old-style vs FastNearnessScorer evals/sec.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/bench-kit-nearness-eval.ts
 */
import { readFileSync } from "node:fs";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import {
    buildCorpusEvalContext,
    DEFAULT_NEARBY_GENOME,
    evaluateNearnessGenome,
    type NearnessGenome,
} from "../src/lib/kit-nearness-corpus-eval";

const corpus = JSON.parse(
    readFileSync("C:/Users/Elliot/Downloads/kit-nearness-corpus.json", "utf8"),
) as AnonymisedKitNearnessCorpus;

const ctx = buildCorpusEvalContext(corpus, {
    minCount: 20,
    maxFolds: 12,
    negativePoolSize: 180,
    visualPositiveThreshold: 14,
    minVisualPositives: 3,
    maxSeedsPerFold: 60,
    maxVisualPositivesPerFold: 32,
});

const genomes: NearnessGenome[] = [];
for (let i = 0; i < 200; i++) {
    genomes.push({
        colorRadius: 4 + (i % 10),
        colorBonus: (i % 20) * 0.15,
        structureGate: 10 + (i % 15),
        rivalTau: 1 + (i % 12),
        rivalLambda: (i % 16) * 0.25,
        maxMedoids: 2 + (i % 5),
        minSeparation: 6 + (i % 10),
    });
}

// Warmup (builds first medoid-config tables)
evaluateNearnessGenome(ctx, DEFAULT_NEARBY_GENOME);
for (const g of genomes.slice(0, 20)) {
    evaluateNearnessGenome(ctx, g);
}

const started = Date.now();
let checksum = 0;
for (const g of genomes) {
    checksum += evaluateNearnessGenome(ctx, g).fitness;
}
const ms = Date.now() - started;
const perSec = (genomes.length / ms) * 1000;
console.log(
    JSON.stringify(
        {
            folds: ctx.folds.length,
            evals: genomes.length,
            ms,
            evalsPerSec: Number(perSec.toFixed(1)),
            checksum: Number(checksum.toFixed(4)),
            configCacheSize: ctx.fastScorer.cacheSize,
            baseline: evaluateNearnessGenome(ctx, DEFAULT_NEARBY_GENOME),
        },
        null,
        2,
    ),
);
