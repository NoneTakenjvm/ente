/**
 * Depth-biased genetic search for one kit's CLIP nearness genome.
 *
 * Tuned for ~3–6 minutes on a typical library: larger population / more gens
 * than a "quick" pass, with UI yields so progress can update.
 */
import {
    DEFAULT_KIT_EMBEDDING_GENOME,
    KIT_EMBEDDING_GENE_SPECS,
    KIT_NEARNESS_TUNE_MIN_LIFT,
    KIT_NEARNESS_TUNE_MIN_MEMBERS,
    clampKitEmbeddingNearnessGenome,
    kitEmbeddingGenomeToValues,
    valuesToKitEmbeddingGenome,
    type KitEmbeddingNearnessGenome,
    type KitNearnessTuneResult,
} from "@/lib/kit-nearness-embedding-genome";
import {
    buildKitEmbeddingEvalFold,
    evaluateKitEmbeddingGenome,
    listEmbeddedKitMembers,
    type KitEmbeddingEvalFold,
    type KitEmbeddingFitnessBreakdown,
} from "@/lib/kit-nearness-embedding-eval";
import type { EnteFile } from "ente-media/file";

export type KitNearnessTuneProgress = {
    phase: "setup" | "search" | "polish" | "done";
    /** Human-readable status line. */
    label: string;
    /** Completed fitness evaluations. */
    current: number;
    /** Estimated total evaluations (search + polish). */
    total: number;
    bestFitness?: number;
    baselineFitness?: number;
};

export type KitNearnessTuneOptions = {
    libraryFiles: readonly EnteFile[];
    kitTags: readonly string[];
    kitId: string;
    embeddings: ReadonlyMap<number, number[]>;
    /** Other kits for rival penalties. */
    rivalKits: readonly {
        id: string;
        tags: readonly string[];
        genome?: KitEmbeddingNearnessGenome;
    }[];
    onProgress?: (progress: KitNearnessTuneProgress) => void;
    signal?: AbortSignal;
    /** RNG seed for reproducibility. */
    seed?: number;
};

/** Depth-first GA settings (~75% quality / 25% time). */
export const KIT_NEARNESS_TUNE_GA = {
    populationSize: 36,
    generations: 70,
    eliteCount: 4,
    tournamentSize: 4,
    mutationRate: 0.32,
    childMutationProbability: 0.92,
    earlyStoppingGenerations: 28,
    restartCount: 2,
    immigrationInterval: 14,
    polishSteps: 48,
    yieldEveryEvals: 4,
} as const;

const mulberry32 = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return (): number => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };
};

const clamp = (value: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, value));

const genomeKey = (values: number[]): string =>
    values
        .map((v, i) => {
            const spec = KIT_EMBEDDING_GENE_SPECS[i]!;
            return spec.integer ? String(Math.round(v)) : v.toFixed(4);
        })
        .join("|");

const randomValues = (random: () => number): number[] =>
    KIT_EMBEDDING_GENE_SPECS.map((spec) => {
        const raw = spec.lo + random() * (spec.hi - spec.lo);
        return spec.integer ? Math.round(raw) : raw;
    });

const perturbValues = (
    source: number[],
    random: () => number,
    scale: number,
): number[] =>
    source.map((v, i) => {
        const spec = KIT_EMBEDDING_GENE_SPECS[i]!;
        const span = spec.hi - spec.lo;
        const jitter = (random() * 2 - 1) * span * scale;
        let next = clamp(v + jitter, spec.lo, spec.hi);
        if (spec.integer) {
            next = Math.round(next);
        }
        return next;
    });

const crossover = (
    a: number[],
    b: number[],
    random: () => number,
): number[] =>
    a.map((v, i) => (random() < 0.5 ? v : b[i]!));

const mutate = (values: number[], random: () => number, rate: number): number[] =>
    values.map((v, i) => {
        if (random() > rate) {
            return v;
        }
        const spec = KIT_EMBEDDING_GENE_SPECS[i]!;
        if (spec.integer && spec.hi - spec.lo <= 4) {
            // Flip / step for small integer genes (useCentroid, maxMedoids).
            const step = random() < 0.5 ? -1 : 1;
            return clamp(Math.round(v) + step, spec.lo, spec.hi);
        }
        const span = spec.hi - spec.lo;
        let next = clamp(v + (random() * 2 - 1) * span * 0.25, spec.lo, spec.hi);
        if (spec.integer) {
            next = Math.round(next);
        }
        return next;
    });

const yieldToUi = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

const throwIfAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) {
        throw new DOMException("Kit nearness tune aborted", "AbortError");
    }
};

/**
 * Run a depth-biased GA for one kit. Returns a persistable result only when the
 * winner beats the default genome by {@link KIT_NEARNESS_TUNE_MIN_LIFT}.
 */
export const runKitNearnessTune = async (
    options: KitNearnessTuneOptions,
): Promise<KitNearnessTuneResult | undefined> => {
    const {
        libraryFiles,
        kitTags,
        embeddings,
        rivalKits,
        onProgress,
        signal,
        seed = Date.now(),
    } = options;

    const report = (progress: KitNearnessTuneProgress): void => {
        onProgress?.(progress);
    };

    report({
        phase: "setup",
        label: "Preparing holdout fold…",
        current: 0,
        total: 1,
    });

    const members = listEmbeddedKitMembers(
        libraryFiles,
        kitTags,
        embeddings,
    );
    if (members.length < KIT_NEARNESS_TUNE_MIN_MEMBERS) {
        throw new Error(
            `Need at least ${KIT_NEARNESS_TUNE_MIN_MEMBERS} CLIP-embedded photos in this kit (have ${members.length}). Run a CLIP scan first.`,
        );
    }

    const random = mulberry32(seed >>> 0);
    const fold = buildKitEmbeddingEvalFold(
        libraryFiles,
        kitTags,
        embeddings,
        rivalKits.filter((kit) => kit.id !== options.kitId),
        { random, negativePoolSize: 220, seedFraction: 0.6 },
    );
    if (!fold) {
        throw new Error(
            "Could not build a holdout fold (need more embedded photos outside this kit).",
        );
    }

    const rivalGenomeList: KitEmbeddingNearnessGenome[] = [];
    for (const rival of rivalKits) {
        if (rival.id === options.kitId || !rival.tags.length) {
            continue;
        }
        const embedded = listEmbeddedKitMembers(
            libraryFiles,
            rival.tags,
            embeddings,
        );
        if (embedded.length >= 2) {
            rivalGenomeList.push(rival.genome ?? DEFAULT_KIT_EMBEDDING_GENOME);
        }
    }

    const settings = KIT_NEARNESS_TUNE_GA;
    const evalsPerRestart =
        settings.populationSize * settings.generations +
        settings.populationSize;
    const estimatedTotal =
        settings.restartCount * evalsPerRestart + settings.polishSteps;

    let evalCount = 0;
    const cache = new Map<string, KitEmbeddingFitnessBreakdown>();

    const evaluate = async (
        values: number[],
    ): Promise<KitEmbeddingFitnessBreakdown> => {
        throwIfAborted(signal);
        const key = genomeKey(values);
        const hit = cache.get(key);
        if (hit) {
            return hit;
        }
        const genome = valuesToKitEmbeddingGenome(values);
        const breakdown = evaluateKitEmbeddingGenome(
            fold,
            embeddings,
            genome,
            rivalGenomeList,
        );
        cache.set(key, breakdown);
        evalCount += 1;
        if (evalCount % settings.yieldEveryEvals === 0) {
            await yieldToUi();
        }
        return breakdown;
    };

    const baseline = await evaluate(
        kitEmbeddingGenomeToValues(DEFAULT_KIT_EMBEDDING_GENOME),
    );

    report({
        phase: "search",
        label: `Baseline fitness ${(baseline.fitness * 100).toFixed(1)}% — searching…`,
        current: evalCount,
        total: estimatedTotal,
        bestFitness: baseline.fitness,
        baselineFitness: baseline.fitness,
    });

    let bestValues = kitEmbeddingGenomeToValues(DEFAULT_KIT_EMBEDDING_GENOME);
    let bestBreakdown = baseline;

    const consider = (
        values: number[],
        breakdown: KitEmbeddingFitnessBreakdown,
    ): void => {
        if (
            breakdown.fitness > bestBreakdown.fitness ||
            (breakdown.fitness === bestBreakdown.fitness &&
                breakdown.holdoutAuc > bestBreakdown.holdoutAuc)
        ) {
            bestValues = [...values];
            bestBreakdown = breakdown;
        }
    };

    for (let restart = 0; restart < settings.restartCount; restart++) {
        throwIfAborted(signal);
        const population: number[][] = Array.from(
            { length: settings.populationSize },
            () =>
                restart === 0 && random() < 0.15 ?
                    kitEmbeddingGenomeToValues(DEFAULT_KIT_EMBEDDING_GENOME) :
                    randomValues(random),
        );
        // Seed a few perturbed copies of the current best.
        for (let i = 0; i < 3 && i < population.length; i++) {
            population[i] = perturbValues(bestValues, random, 0.15);
        }

        let scored = await Promise.all(
            population.map(async (values) => ({
                values,
                breakdown: await evaluate(values),
            })),
        );
        for (const row of scored) {
            consider(row.values, row.breakdown);
        }

        let stagnant = 0;
        let lastBest = bestBreakdown.fitness;

        for (let gen = 0; gen < settings.generations; gen++) {
            throwIfAborted(signal);
            scored.sort((a, b) => b.breakdown.fitness - a.breakdown.fitness);
            const elites = scored
                .slice(0, settings.eliteCount)
                .map((row) => [...row.values]);

            const nextPop: number[][] = [...elites];
            while (nextPop.length < settings.populationSize) {
                const pick = (): number[] => {
                    let winner = scored[0]!;
                    for (let t = 0; t < settings.tournamentSize; t++) {
                        const challenger =
                            scored[Math.floor(random() * scored.length)]!;
                        if (
                            challenger.breakdown.fitness >
                            winner.breakdown.fitness
                        ) {
                            winner = challenger;
                        }
                    }
                    return winner.values;
                };
                let child = crossover(pick(), pick(), random);
                if (random() < settings.childMutationProbability) {
                    child = mutate(child, random, settings.mutationRate);
                }
                nextPop.push(child);
            }

            if (
                gen > 0 &&
                gen % settings.immigrationInterval === 0
            ) {
                const immigrants = Math.max(2, Math.floor(settings.populationSize * 0.1));
                for (let i = 0; i < immigrants; i++) {
                    const idx =
                        settings.populationSize - 1 - i;
                    if (idx >= settings.eliteCount) {
                        nextPop[idx] = randomValues(random);
                    }
                }
            }

            scored = await Promise.all(
                nextPop.map(async (values) => ({
                    values,
                    breakdown: await evaluate(values),
                })),
            );
            for (const row of scored) {
                consider(row.values, row.breakdown);
            }

            if (bestBreakdown.fitness > lastBest + 1e-6) {
                lastBest = bestBreakdown.fitness;
                stagnant = 0;
            } else {
                stagnant += 1;
            }

            report({
                phase: "search",
                label: `Restart ${restart + 1}/${settings.restartCount}, gen ${gen + 1}/${settings.generations} — best ${(bestBreakdown.fitness * 100).toFixed(1)}%`,
                current: Math.min(evalCount, estimatedTotal),
                total: estimatedTotal,
                bestFitness: bestBreakdown.fitness,
                baselineFitness: baseline.fitness,
            });

            if (stagnant >= settings.earlyStoppingGenerations) {
                break;
            }
        }
    }

    report({
        phase: "polish",
        label: "Polishing best genome…",
        current: Math.min(evalCount, estimatedTotal),
        total: estimatedTotal,
        bestFitness: bestBreakdown.fitness,
        baselineFitness: baseline.fitness,
    });

    let polishScale = 0.12;
    for (let step = 0; step < settings.polishSteps; step++) {
        throwIfAborted(signal);
        const candidate = perturbValues(bestValues, random, polishScale);
        const breakdown = await evaluate(candidate);
        if (breakdown.fitness > bestBreakdown.fitness) {
            consider(candidate, breakdown);
            polishScale = Math.min(0.2, polishScale * 1.05);
        } else {
            polishScale = Math.max(0.03, polishScale * 0.92);
        }
        if (step % 4 === 0) {
            report({
                phase: "polish",
                label: `Polish ${step + 1}/${settings.polishSteps} — best ${(bestBreakdown.fitness * 100).toFixed(1)}%`,
                current: Math.min(evalCount, estimatedTotal),
                total: estimatedTotal,
                bestFitness: bestBreakdown.fitness,
                baselineFitness: baseline.fitness,
            });
        }
    }

    const genome = clampKitEmbeddingNearnessGenome(
        valuesToKitEmbeddingGenome(bestValues),
    );
    const lift = bestBreakdown.fitness - baseline.fitness;

    report({
        phase: "done",
        label:
            lift >= KIT_NEARNESS_TUNE_MIN_LIFT ?
                `Kept tune (+${(lift * 100).toFixed(1)} pp vs default)` :
                `No gain over default (Δ ${(lift * 100).toFixed(1)} pp) — keeping global`,
        current: estimatedTotal,
        total: estimatedTotal,
        bestFitness: bestBreakdown.fitness,
        baselineFitness: baseline.fitness,
    });

    if (lift < KIT_NEARNESS_TUNE_MIN_LIFT) {
        return undefined;
    }

    return {
        genome,
        fitness: bestBreakdown.fitness,
        holdoutAuc: bestBreakdown.holdoutAuc,
        holdoutTopK: bestBreakdown.holdoutTopK,
        baselineFitness: baseline.fitness,
        tunedAt: Date.now(),
        memberCount: members.length,
    };
};

// Keep fold typing available for callers that build custom folds.
export type { KitEmbeddingEvalFold };
