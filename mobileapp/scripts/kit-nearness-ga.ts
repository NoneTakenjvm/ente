/**
 * Offline genetic search for kit-nearness knobs against a private corpus.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-ga.ts ^
 *     --corpus C:/Users/Elliot/Downloads/kit-nearness-corpus.json
 *
 * Writes `.spike-out/kit-nearness-ga-best.json` and appends to
 * `scripts/kit-nearness-ga-notes.md`.
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import {
    buildCorpusEvalContext,
    evaluateNearnessGenome,
} from "../src/lib/kit-nearness-corpus-eval";
import {
    DEFAULT_GA_SETTINGS,
    runNearnessGeneticSearch,
    type GaSettings,
} from "./kit-nearness-ga-search";

const getFlag = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    if (index < 0) {
        return undefined;
    }
    return process.argv[index + 1];
};

const main = (): void => {
    const corpusPath =
        getFlag("--corpus") ??
        "C:/Users/Elliot/Downloads/kit-nearness-corpus.json";
    const outDir = join(process.cwd(), ".spike-out");
    mkdirSync(outDir, { recursive: true });

    const raw = JSON.parse(
        readFileSync(corpusPath, "utf8"),
    ) as AnonymisedKitNearnessCorpus;
    console.log(
        `corpus v${raw.version}: photos=${raw.photos.length} derivedKits=${raw.derivedKits?.length ?? 0}`,
    );

    const minCount = Number(getFlag("--min-count") ?? 50);
    const ctx = buildCorpusEvalContext(raw, {
        minCount,
        maxFolds: 12,
        foldSeed: 42,
        negativePoolSize: 180,
        visualPositiveThreshold: 14,
        minVisualPositives: 3,
        maxSeedsPerFold: 60,
        maxVisualPositivesPerFold: 32,
    });
    console.log(
        `eval folds=${ctx.folds.length} (minCount=${minCount}) negatives=${ctx.negativePool.length}`,
    );
    if (!ctx.folds.length) {
        console.error("No folds — relax visualPositiveThreshold / minCount");
        process.exitCode = 1;
        return;
    }
    for (const fold of ctx.folds.slice(0, 8)) {
        console.log(
            `  ${fold.kitId} meanPair=${fold.meanPairwise.toFixed(1)} seeds=${fold.seedIds.length} hold=${fold.holdoutIds.length} visualPos=${fold.visualHoldoutIds.length}`,
        );
    }

    const settings: GaSettings = {
        ...DEFAULT_GA_SETTINGS,
        populationSize: Number(getFlag("--pop") ?? DEFAULT_GA_SETTINGS.populationSize),
        generations: Number(getFlag("--gens") ?? DEFAULT_GA_SETTINGS.generations),
        restartCount: Number(getFlag("--restarts") ?? DEFAULT_GA_SETTINGS.restartCount),
        seed: Number(getFlag("--seed") ?? DEFAULT_GA_SETTINGS.seed),
    };

    console.log(
        `\nGA pop=${settings.populationSize} gens=${settings.generations} restarts=${settings.restartCount}`,
    );
    const started = Date.now();
    const result = runNearnessGeneticSearch(ctx, settings, (event) => {
        const b = event.best.breakdown;
        console.log(
            `  r${event.restart} gen ${String(event.generation).padStart(3)}  ` +
                `fit=${b.fitness.toFixed(4)} auc=${b.holdoutAuc.toFixed(3)} ` +
                `topK=${b.holdoutTopK.toFixed(3)} excl=${b.exclAuc.toFixed(3)} ` +
                `evals=${event.evalCount} cache=${event.cacheSize}` +
                (event.earlyStopped ? " EARLY" : ""),
        );
    });
    const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

    // Re-score best for clean print
    const bestScore = evaluateNearnessGenome(ctx, result.best.genome);
    const baselineScore = result.baseline.breakdown;

    console.log(`\n=== done in ${elapsedSec}s  evals=${result.evalCount} ===`);
    console.log(
        `baseline fit=${baselineScore.fitness.toFixed(4)} auc=${baselineScore.holdoutAuc.toFixed(3)} topK=${baselineScore.holdoutTopK.toFixed(3)} excl=${baselineScore.exclAuc.toFixed(3)}`,
    );
    console.log(
        `best     fit=${bestScore.fitness.toFixed(4)} auc=${bestScore.holdoutAuc.toFixed(3)} topK=${bestScore.holdoutTopK.toFixed(3)} excl=${bestScore.exclAuc.toFixed(3)} softLift=${bestScore.softRivalLift.toFixed(2)}`,
    );
    console.log("best genome:", JSON.stringify(result.best.genome, null, 2));

    const payload = {
        corpusPath,
        elapsedSec: Number(elapsedSec),
        settings,
        foldCount: ctx.folds.length,
        baseline: result.baseline,
        best: { genome: result.best.genome, breakdown: bestScore },
        restarts: result.restarts,
        evalCount: result.evalCount,
        generationsExecuted: result.generationsExecuted,
        deltaFitness: bestScore.fitness - baselineScore.fitness,
    };
    const outPath = join(outDir, "kit-nearness-ga-best.json");
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`wrote ${outPath}`);

    const notesPath = join(process.cwd(), "scripts/kit-nearness-ga-notes.md");
    const note = `
### Run ${new Date().toISOString()}

- Corpus folds: ${ctx.folds.length}; evals=${result.evalCount}; ${elapsedSec}s; restarts=${settings.restartCount}
- Baseline fitness: **${baselineScore.fitness.toFixed(4)}** (auc=${baselineScore.holdoutAuc.toFixed(3)} topK=${baselineScore.holdoutTopK.toFixed(3)} excl=${baselineScore.exclAuc.toFixed(3)})
- Best fitness: **${bestScore.fitness.toFixed(4)}** (Δ=${(bestScore.fitness - baselineScore.fitness).toFixed(4)})
- Best genome: \`${JSON.stringify(result.best.genome)}\`
- Artifact: \`.spike-out/kit-nearness-ga-best.json\`
`;
    appendFileSync(notesPath, note);
};

main();
