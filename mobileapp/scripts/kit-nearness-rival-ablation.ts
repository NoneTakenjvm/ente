import { readFileSync } from "node:fs";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import {
    DEFAULT_NEARBY_GENOME,
    buildCorpusEvalContext,
    evaluateNearnessGenome,
    type NearnessGenome,
} from "../src/lib/kit-nearness-corpus-eval";

const raw = JSON.parse(
    readFileSync("C:/Users/Elliot/Downloads/kit-nearness-corpus.json", "utf8"),
) as AnonymisedKitNearnessCorpus;

const ctx = buildCorpusEvalContext(raw, {
    minCount: 50,
    maxFolds: 12,
    foldSeed: 42,
    negativePoolSize: 180,
    visualPositiveThreshold: 14,
    minVisualPositives: 3,
    maxSeedsPerFold: 60,
    maxVisualPositivesPerFold: 32,
});

const variants: { name: string; genome: NearnessGenome }[] = [
    { name: "prod (rivals on)", genome: DEFAULT_NEARBY_GENOME },
    {
        name: "prod, no push-down",
        genome: { ...DEFAULT_NEARBY_GENOME, rivalLambda: 0 },
    },
    {
        name: "prod, soft push (λ=1)",
        genome: { ...DEFAULT_NEARBY_GENOME, rivalLambda: 1 },
    },
    {
        name: "GA best (≥50)",
        genome: {
            colorRadius: 3,
            colorBonus: 1.67,
            structureGate: 18,
            rivalTau: 5.06,
            rivalLambda: 4,
            maxMedoids: 4,
            minSeparation: 10,
        },
    },
    {
        name: "GA best, no push-down",
        genome: {
            colorRadius: 3,
            colorBonus: 1.67,
            structureGate: 18,
            rivalTau: 5.06,
            rivalLambda: 0,
            maxMedoids: 4,
            minSeparation: 10,
        },
    },
];

for (const { name, genome } of variants) {
    const s = evaluateNearnessGenome(ctx, genome);
    const pairwise = Math.round(s.holdoutAuc * 100);
    const top = Math.round(s.holdoutTopK * 100);
    console.log(
        `${name}\n  pairwise~${pairwise}%  topSlots~${top}%  excl=${s.exclAuc.toFixed(3)}  fit=${s.fitness.toFixed(4)}\n`,
    );
}
