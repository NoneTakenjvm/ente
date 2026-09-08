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
    minCount: 20,
    maxFolds: 12,
    foldSeed: 42,
    negativePoolSize: 180,
    visualPositiveThreshold: 14,
    minVisualPositives: 3,
    maxSeedsPerFold: 60,
    maxVisualPositivesPerFold: 32,
});

const candidates: { name: string; genome: NearnessGenome }[] = [
    { name: "prod", genome: DEFAULT_NEARBY_GENOME },
    {
        name: "ga-best",
        genome: {
            colorRadius: 2,
            colorBonus: 2.73,
            structureGate: 19,
            rivalTau: 2.14,
            rivalLambda: 3.57,
            maxMedoids: 3,
            minSeparation: 10,
        },
    },
    {
        name: "hybrid-picsum+ga",
        genome: {
            ...DEFAULT_NEARBY_GENOME,
            rivalTau: 2,
            rivalLambda: 3.5,
            maxMedoids: 3,
        },
    },
];

for (const { name, genome } of candidates) {
    const s = evaluateNearnessGenome(ctx, genome);
    console.log(
        `${name} fit=${s.fitness.toFixed(4)} auc=${s.holdoutAuc.toFixed(3)} topK=${s.holdoutTopK.toFixed(3)} excl=${s.exclAuc.toFixed(3)}`,
    );
}
