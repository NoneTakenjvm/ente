/**
 * Score current production knobs against a corpus (baseline, no GA).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-baseline.ts ^
 *     --corpus C:/Users/Elliot/Downloads/kit-nearness-corpus.json
 */
import { readFileSync } from "node:fs";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import {
    DEFAULT_NEARBY_GENOME,
    buildCorpusEvalContext,
    evaluateNearnessGenome,
} from "../src/lib/kit-nearness-corpus-eval";

const getFlag = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    if (index < 0) {
        return undefined;
    }
    return process.argv[index + 1];
};

const corpusPath =
    getFlag("--corpus") ??
    "C:/Users/Elliot/Downloads/kit-nearness-corpus.json";

const raw = JSON.parse(
    readFileSync(corpusPath, "utf8"),
) as AnonymisedKitNearnessCorpus;

console.log(
    `corpus v${raw.version}: photos=${raw.photos.length} kits=${raw.kits.length} derivedKits=${raw.derivedKits?.length ?? 0}`,
);

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

console.log(
    `eval folds=${ctx.folds.length} negatives=${ctx.negativePool.length}`,
);
if (!ctx.folds.length) {
    console.error("No folds — relax thresholds");
    process.exitCode = 1;
    process.exit();
}

for (const fold of ctx.folds) {
    console.log(
        `  ${fold.kitId} meanPair=${fold.meanPairwise.toFixed(1)} seeds=${fold.seedIds.length} hold=${fold.holdoutIds.length} visualPos=${fold.visualHoldoutIds.length}`,
    );
}

const score = evaluateNearnessGenome(ctx, DEFAULT_NEARBY_GENOME);
console.log("\ngenome (production hybrid):", JSON.stringify(DEFAULT_NEARBY_GENOME));
console.log(
    `baseline fitness=${score.fitness.toFixed(4)} auc=${score.holdoutAuc.toFixed(3)} topK=${score.holdoutTopK.toFixed(3)} excl=${score.exclAuc.toFixed(3)} softRival=${score.softRivalLift.toFixed(3)} kits=${score.kitCount}`,
);
