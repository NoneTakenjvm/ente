/**
 * Majority-kit likeness GA against a private corpus.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-majority-ga.ts ^
 *     --corpus C:/Users/Elliot/Downloads/kit-nearness-corpus.json --min-count 50
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import {
    DEFAULT_NEARBY_GENOME,
    buildCorpusEvalContext,
    evaluateNearnessGenome,
} from "../src/lib/kit-nearness-corpus-eval";
import {
    DEFAULT_MAJORITY_GENOME,
    buildMajorityEvalContext,
    evaluateMajorityGenome,
} from "../src/lib/kit-nearness-majority-eval";
import { DEFAULT_GA_SETTINGS, type GaSettings } from "./kit-nearness-ga-search";
import { runMajorityGeneticSearch } from "./kit-nearness-majority-ga-search";

const getFlag = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    if (index < 0) {
        return undefined;
    }
    return process.argv[index + 1];
};

const pct = (rate: number): string => `${Math.round(rate * 100)}%`;

const main = (): void => {
    const corpusPath =
        getFlag("--corpus") ??
        "C:/Users/Elliot/Downloads/kit-nearness-corpus.json";
    const minCount = Number(getFlag("--min-count") ?? 50);
    const outDir = join(process.cwd(), ".spike-out");
    mkdirSync(outDir, { recursive: true });

    const raw = JSON.parse(
        readFileSync(corpusPath, "utf8"),
    ) as AnonymisedKitNearnessCorpus;
    console.log(
        `corpus v${raw.version}: photos=${raw.photos.length} derivedKits=${raw.derivedKits?.length ?? 0}`,
    );

    const foldOpts = {
        minCount,
        maxFolds: 12,
        foldSeed: 42,
        negativePoolSize: 180,
        visualPositiveThreshold: 14,
        minVisualPositives: 3,
        maxSeedsPerFold: 60,
        maxVisualPositivesPerFold: 32,
    };

    const medoidCtx = buildCorpusEvalContext(raw, foldOpts);
    const majorityCtx = buildMajorityEvalContext(raw, foldOpts);
    console.log(
        `folds=${majorityCtx.folds.length} (minCount=${minCount}) negatives=${majorityCtx.negativePool.length}`,
    );
    if (!majorityCtx.folds.length) {
        console.error("No folds");
        process.exitCode = 1;
        return;
    }

    const medoidProd = evaluateNearnessGenome(medoidCtx, DEFAULT_NEARBY_GENOME);
    const majorityDefault = evaluateMajorityGenome(
        majorityCtx,
        DEFAULT_MAJORITY_GENOME,
    );
    console.log("\n--- plain English baselines (same folds) ---");
    console.log(
        `Medoid system (current app): pairwise ${pct(medoidProd.holdoutAuc)}, top slots ${pct(medoidProd.holdoutTopK)}`,
    );
    console.log(
        `Majority default (T=${DEFAULT_MAJORITY_GENOME.matchThreshold}, no push): pairwise ${pct(majorityDefault.holdoutAuc)}, top slots ${pct(majorityDefault.holdoutTopK)}`,
    );

    const settings: GaSettings = {
        ...DEFAULT_GA_SETTINGS,
        populationSize: Number(getFlag("--pop") ?? 96),
        generations: Number(getFlag("--gens") ?? 200),
        restartCount: Number(getFlag("--restarts") ?? 3),
        seed: Number(getFlag("--seed") ?? DEFAULT_GA_SETTINGS.seed),
    };

    console.log(
        `\nMajority GA pop=${settings.populationSize} gens=${settings.generations} restarts=${settings.restartCount}`,
    );
    const started = Date.now();
    const result = runMajorityGeneticSearch(
        majorityCtx,
        settings,
        (event) => {
            const g = event.genome as unknown as typeof DEFAULT_MAJORITY_GENOME;
            const b = event.best.breakdown;
            console.log(
                `  r${event.restart} gen ${String(event.generation).padStart(3)}  fit=${b.fitness.toFixed(4)} pairwise=${pct(b.holdoutAuc)} top=${pct(b.holdoutTopK)} T=${g.matchThreshold} y=${g.minMatchFraction.toFixed(2)} λ=${g.rivalLambda.toFixed(2)} seeds=${g.maxSeeds}${event.earlyStopped ? " EARLY" : ""}`,
            );
        },
    );
    const elapsedSec = (Date.now() - started) / 1000;
    const bestG = result.best.majorityGenome;
    const best = result.best.breakdown;
    const base = result.baseline.breakdown;

    console.log(`\n=== done in ${elapsedSec.toFixed(1)}s  evals=${result.evalCount} ===`);
    console.log(
        `majority default: pairwise ${pct(base.holdoutAuc)}, top ${pct(base.holdoutTopK)}`,
    );
    console.log(
        `majority GA best: pairwise ${pct(best.holdoutAuc)}, top ${pct(best.holdoutTopK)}`,
    );
    console.log(`best genome: ${JSON.stringify(bestG, null, 2)}`);
    console.log(
        `\nvs current medoid app: pairwise ${pct(medoidProd.holdoutAuc)}→${pct(best.holdoutAuc)}, top ${pct(medoidProd.holdoutTopK)}→${pct(best.holdoutTopK)}`,
    );

    const artifact = {
        mode: "majority",
        corpusPath,
        minCount,
        elapsedSec,
        settings,
        foldCount: majorityCtx.folds.length,
        medoidProd,
        majorityDefault: { genome: DEFAULT_MAJORITY_GENOME, breakdown: base },
        best: { genome: bestG, breakdown: best },
        evalCount: result.evalCount,
    };
    const outPath = join(outDir, "kit-nearness-majority-ga-best.json");
    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`wrote ${outPath}`);

    const stamp = new Date().toISOString();
    appendFileSync(
        join(process.cwd(), "scripts/kit-nearness-ga-notes.md"),
        `
### Majority GA ${stamp}

- minCount=${minCount}; folds=${majorityCtx.folds.length}; evals=${result.evalCount}; ${elapsedSec.toFixed(1)}s
- Medoid prod: pairwise **${pct(medoidProd.holdoutAuc)}** top **${pct(medoidProd.holdoutTopK)}**
- Majority default: pairwise **${pct(base.holdoutAuc)}** top **${pct(base.holdoutTopK)}**
- Majority GA best: pairwise **${pct(best.holdoutAuc)}** top **${pct(best.holdoutTopK)}**
- Genome: \`T=${bestG.matchThreshold} y=${bestG.minMatchFraction.toFixed(3)} λ=${bestG.rivalLambda.toFixed(2)} maxSeeds=${bestG.maxSeeds}\`
`,
    );
};

main();
