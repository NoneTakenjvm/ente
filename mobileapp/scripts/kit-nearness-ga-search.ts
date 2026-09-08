/**
 * Emperor-style genetic search over {@link NearnessGenome} knobs.
 *
 * Mechanics ported from the combat simulator GA: multi-restart, fitness cache,
 * elitism, tournament, fitness-biased crossover, multi-mode + adaptive mutation,
 * periodic/stagnation immigration, early-stop with polish recovery, final polish.
 */
import {
    DEFAULT_NEARBY_GENOME,
    evaluateNearnessGenome,
    type CorpusEvalContext,
    type FitnessBreakdown,
    type NearnessGenome,
} from "@/lib/kit-nearness-corpus-eval";

export type GeneSpec = {
    key: keyof NearnessGenome;
    lo: number;
    hi: number;
    integer: boolean;
};

export const GENE_SPECS: readonly GeneSpec[] = [
    { key: "colorRadius", lo: 0, hi: 16, integer: true },
    { key: "colorBonus", lo: 0, hi: 3, integer: false },
    { key: "structureGate", lo: 8, hi: 32, integer: true },
    { key: "rivalTau", lo: 1, hi: 24, integer: false },
    { key: "rivalLambda", lo: 0, hi: 4, integer: false },
    { key: "maxMedoids", lo: 2, hi: 8, integer: true },
    { key: "minSeparation", lo: 4, hi: 20, integer: true },
];

export type GaSettings = {
    populationSize: number;
    generations: number;
    eliteCount: number;
    tournamentSize: number;
    mutationRate: number;
    childMutationProbability: number;
    earlyStoppingGenerations: number;
    restartCount: number;
    immigrationInterval: number;
    periodicImmigrationInterval: number;
    stagnationRecoveryAttempts: number;
    enableAdaptiveMutation: number;
    seed: number;
    polishSteps: number;
};

export const DEFAULT_GA_SETTINGS: GaSettings = {
    populationSize: 96,
    generations: 200,
    eliteCount: 5,
    tournamentSize: 5,
    mutationRate: 0.28,
    childMutationProbability: 0.95,
    earlyStoppingGenerations: 35,
    restartCount: 3,
    immigrationInterval: 12,
    periodicImmigrationInterval: 25,
    stagnationRecoveryAttempts: 3,
    enableAdaptiveMutation: 1,
    seed: 20260907,
    polishSteps: 24,
};

export type ScoredCandidate = {
    genome: NearnessGenome;
    breakdown: FitnessBreakdown;
};

type InternalCandidate = {
    values: number[];
    breakdown: FitnessBreakdown | null;
};

const clamp = (value: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, value));

const mulberry32 = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return (): number => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };
};

export const genomeToValues = (genome: NearnessGenome): number[] =>
    GENE_SPECS.map((spec) => genome[spec.key]);

export const valuesToGenome = (values: number[]): NearnessGenome => {
    const genome = { ...DEFAULT_NEARBY_GENOME };
    for (let i = 0; i < GENE_SPECS.length; i++) {
        const spec = GENE_SPECS[i]!;
        let v = clamp(values[i]!, spec.lo, spec.hi);
        if (spec.integer) {
            v = Math.round(v);
        }
        genome[spec.key] = v;
    }
    return genome;
};

const copyValues = (values: number[]): number[] => [...values];

const genomeKey = (values: number[]): string =>
    values
        .map((v, i) => {
            const spec = GENE_SPECS[i]!;
            return spec.integer ? String(Math.round(v)) : v.toFixed(4);
        })
        .join("|");

const randomValues = (random: () => number): number[] =>
    GENE_SPECS.map((spec) => {
        const raw = spec.lo + random() * (spec.hi - spec.lo);
        return spec.integer ? Math.round(raw) : raw;
    });

const perturbValues = (
    source: number[],
    random: () => number,
    scale: number = 0.2,
): number[] =>
    source.map((v, i) => {
        const spec = GENE_SPECS[i]!;
        const span = spec.hi - spec.lo;
        const jitter = (random() * 2 - 1) * span * scale;
        let next = clamp(v + jitter, spec.lo, spec.hi);
        if (spec.integer) {
            next = Math.round(next);
        }
        return next;
    });

/**
 * Multi-mode mutation (Emperor-style diversity of operators).
 */
const mutateValues = (
    values: number[],
    mutationRate: number,
    random: () => number,
): void => {
    for (let i = 0; i < values.length; i++) {
        if (random() >= mutationRate) {
            continue;
        }
        const spec = GENE_SPECS[i]!;
        const span = spec.hi - spec.lo;
        const mode = Math.floor(random() * 5);
        let next = values[i]!;
        if (mode === 0) {
            // gaussian-ish local step
            next = next + (random() + random() + random() - 1.5) * span * 0.08;
        } else if (mode === 1) {
            // larger jump
            next = next + (random() * 2 - 1) * span * 0.35;
        } else if (mode === 2) {
            // reset to random in range
            next = spec.lo + random() * span;
        } else if (mode === 3) {
            // snap toward default
            const def = DEFAULT_NEARBY_GENOME[spec.key];
            next = next + (def - next) * (0.3 + random() * 0.5);
        } else {
            // creep ±1 unit for ints, small for floats
            next = next + (random() < 0.5 ? -1 : 1) * (spec.integer ? 1 : span * 0.05);
        }
        next = clamp(next, spec.lo, spec.hi);
        values[i] = spec.integer ? Math.round(next) : next;
    }
};

/**
 * Fitness-biased blend crossover with occasional gene swap.
 */
const crossover = (
    a: number[],
    b: number[],
    fitnessA: number,
    fitnessB: number,
    random: () => number,
): number[] => {
    const total = Math.max(1e-9, fitnessA + fitnessB);
    const weightA = fitnessA / total;
    const child: number[] = [];
    for (let i = 0; i < a.length; i++) {
        const spec = GENE_SPECS[i]!;
        let value: number;
        if (random() < 0.25) {
            value = random() < weightA ? a[i]! : b[i]!;
        } else {
            const t = 0.35 + random() * 0.3;
            const blend =
                random() < weightA ?
                    a[i]! * t + b[i]! * (1 - t)
                :   b[i]! * t + a[i]! * (1 - t);
            value = blend;
        }
        value = clamp(value, spec.lo, spec.hi);
        child.push(spec.integer ? Math.round(value) : value);
    }
    return child;
};

export type GaProgressEvent = {
    restart: number;
    generation: number;
    best: ScoredCandidate;
    evalCount: number;
    cacheSize: number;
    earlyStopped?: boolean;
};

export type GaSearchResult = {
    best: ScoredCandidate;
    baseline: ScoredCandidate;
    restarts: ScoredCandidate[];
    evalCount: number;
    generationsExecuted: number;
};

/**
 * Run the genetic search against a fixed corpus eval context.
 */
export const runNearnessGeneticSearch = (
    ctx: CorpusEvalContext,
    settings: GaSettings = DEFAULT_GA_SETTINGS,
    onProgress?: (event: GaProgressEvent) => void,
): GaSearchResult => {
    const cache = new Map<string, FitnessBreakdown>();
    let evalCount = 0;

    const evaluate = (values: number[]): FitnessBreakdown => {
        const key = genomeKey(values);
        const hit = cache.get(key);
        if (hit) {
            return hit;
        }
        evalCount += 1;
        const breakdown = evaluateNearnessGenome(
            ctx,
            valuesToGenome(values),
        );
        if (cache.size > 80_000) {
            cache.clear();
        }
        cache.set(key, breakdown);
        return breakdown;
    };

    const ensureScored = (candidate: InternalCandidate): void => {
        if (!candidate.breakdown) {
            candidate.breakdown = evaluate(candidate.values);
        }
    };

    const compare = (a: InternalCandidate, b: InternalCandidate): number =>
        (b.breakdown?.fitness ?? -Infinity) - (a.breakdown?.fitness ?? -Infinity);

    const tournamentSelect = (
        population: InternalCandidate[],
        random: () => number,
    ): InternalCandidate => {
        let best = population[Math.floor(random() * population.length)]!;
        for (let i = 1; i < settings.tournamentSize; i++) {
            const other =
                population[Math.floor(random() * population.length)]!;
            if (
                (other.breakdown?.fitness ?? -Infinity) >
                (best.breakdown?.fitness ?? -Infinity)
            ) {
                best = other;
            }
        }
        return best;
    };

    const resolveMutationRate = (population: InternalCandidate[]): number => {
        if (!settings.enableAdaptiveMutation) {
            return settings.mutationRate;
        }
        const fitnesses = population.map((c) => c.breakdown?.fitness ?? 0);
        const mean =
            fitnesses.reduce((a, b) => a + b, 0) / Math.max(1, fitnesses.length);
        const variance =
            fitnesses.reduce((a, f) => a + (f - mean) ** 2, 0) /
            Math.max(1, fitnesses.length);
        // Low diversity → bump mutation
        if (variance < 1e-6) {
            return Math.min(0.65, settings.mutationRate * 1.8);
        }
        if (variance < 5e-5) {
            return Math.min(0.5, settings.mutationRate * 1.35);
        }
        return settings.mutationRate;
    };

    const injectImmigrants = (
        population: InternalCandidate[],
        best: InternalCandidate,
        random: () => number,
        aggressive: boolean,
    ): void => {
        const count = aggressive ?
            Math.max(8, Math.floor(population.length / 4))
        :   Math.max(4, Math.floor(population.length / 8));
        for (let i = 0; i < count; i++) {
            const mode = i % 5;
            let values: number[];
            if (mode === 0) {
                values = perturbValues(best.values, random, 0.25);
            } else if (mode === 1) {
                values = randomValues(random);
            } else if (mode === 2) {
                values = perturbValues(
                    genomeToValues(DEFAULT_NEARBY_GENOME),
                    random,
                    0.4,
                );
            } else if (mode === 3) {
                values = perturbValues(best.values, random, 0.5);
            } else {
                values = perturbValues(randomValues(random), random, 0.3);
            }
            const immigrant: InternalCandidate = {
                values,
                breakdown: evaluate(values),
            };
            const replaceIndex = population.length - 1 - i;
            if (replaceIndex <= settings.eliteCount) {
                break;
            }
            population[replaceIndex] = immigrant;
        }
    };

    const polish = (
        values: number[],
        breakdown: FitnessBreakdown,
        random: () => number,
        steps: number = settings.polishSteps,
    ): InternalCandidate => {
        let bestValues = copyValues(values);
        let bestBreakdown = breakdown;
        for (let step = 0; step < steps; step++) {
            const trial = copyValues(bestValues);
            const gene = Math.floor(random() * trial.length);
            const spec = GENE_SPECS[gene]!;
            const span = spec.hi - spec.lo;
            const delta =
                (random() < 0.5 ? -1 : 1) *
                (spec.integer ? 1 : span * (0.02 + random() * 0.06));
            trial[gene] = clamp(
                trial[gene]! + delta,
                spec.lo,
                spec.hi,
            );
            if (spec.integer) {
                trial[gene] = Math.round(trial[gene]!);
            }
            const next = evaluate(trial);
            if (next.fitness > bestBreakdown.fitness) {
                bestValues = trial;
                bestBreakdown = next;
            }
        }
        // Coordinate sweep once
        for (let gene = 0; gene < GENE_SPECS.length; gene++) {
            const spec = GENE_SPECS[gene]!;
            const steps = spec.integer ?
                [ -2, -1, 1, 2 ]
            :   [ -0.15, -0.05, 0.05, 0.15 ].map((f) => f * (spec.hi - spec.lo));
            for (const delta of steps) {
                const trial = copyValues(bestValues);
                trial[gene] = clamp(trial[gene]! + delta, spec.lo, spec.hi);
                if (spec.integer) {
                    trial[gene] = Math.round(trial[gene]!);
                }
                const next = evaluate(trial);
                if (next.fitness > bestBreakdown.fitness) {
                    bestValues = trial;
                    bestBreakdown = next;
                }
            }
        }
        return { values: bestValues, breakdown: bestBreakdown };
    };

    const initializePopulation = (random: () => number): InternalCandidate[] => {
        const population: InternalCandidate[] = [];
        const defaults = genomeToValues(DEFAULT_NEARBY_GENOME);
        population.push({ values: copyValues(defaults), breakdown: null });
        const seedBudget = Math.max(4, Math.floor(settings.populationSize * 0.35));
        for (let i = 1; i < seedBudget; i++) {
            population.push({
                values: perturbValues(defaults, random, 0.15 + (i % 5) * 0.08),
                breakdown: null,
            });
        }
        let slot = 0;
        while (population.length < settings.populationSize) {
            if (slot % 5 === 1) {
                // sparse: mostly defaults with 1–2 genes randomised
                const values = copyValues(defaults);
                const flips = 1 + Math.floor(random() * 2);
                for (let f = 0; f < flips; f++) {
                    const g = Math.floor(random() * values.length);
                    const spec = GENE_SPECS[g]!;
                    const raw = spec.lo + random() * (spec.hi - spec.lo);
                    values[g] = spec.integer ? Math.round(raw) : raw;
                }
                population.push({ values, breakdown: null });
            } else if (slot % 4 === 0 && population.length > 1) {
                const parent =
                    population[Math.floor(random() * population.length)]!;
                population.push({
                    values: perturbValues(parent.values, random, 0.3),
                    breakdown: null,
                });
            } else {
                population.push({ values: randomValues(random), breakdown: null });
            }
            slot += 1;
        }
        return population;
    };

    const searchOnce = (restartIndex: number): {
        best: InternalCandidate;
        generationsExecuted: number;
    } => {
        const random = mulberry32(settings.seed + restartIndex * 982451653);
        let population = initializePopulation(random);
        for (const c of population) {
            ensureScored(c);
        }
        population.sort(compare);
        let best = {
            values: copyValues(population[0]!.values),
            breakdown: population[0]!.breakdown,
        };
        let noImprovement = 0;
        let stagnationRecoveries = 0;
        let generationsExecuted = 0;
        let earlyStopped = false;

        for (let generation = 1; generation <= settings.generations; generation++) {
            generationsExecuted = generation;
            const next: InternalCandidate[] = [];
            for (let e = 0; e < settings.eliteCount; e++) {
                const elite = population[e]!;
                next.push({
                    values: copyValues(elite.values),
                    breakdown: elite.breakdown,
                });
            }
            const mutationRate = resolveMutationRate(population);
            while (next.length < settings.populationSize) {
                const parentA = tournamentSelect(population, random);
                const parentB = tournamentSelect(population, random);
                const child = crossover(
                    parentA.values,
                    parentB.values,
                    parentA.breakdown?.fitness ?? 0,
                    parentB.breakdown?.fitness ?? 0,
                    random,
                );
                if (random() < settings.childMutationProbability) {
                    mutateValues(child, mutationRate, random);
                }
                next.push({ values: child, breakdown: null });
            }
            for (const c of next) {
                ensureScored(c);
            }
            next.sort(compare);
            population = next;

            if (
                settings.periodicImmigrationInterval > 0 &&
                generation % settings.periodicImmigrationInterval === 0
            ) {
                injectImmigrants(population, best, random, false);
                population.sort(compare);
            }

            const generationBest = population[0]!;
            if (
                (generationBest.breakdown?.fitness ?? -Infinity) >
                (best.breakdown?.fitness ?? -Infinity)
            ) {
                best = {
                    values: copyValues(generationBest.values),
                    breakdown: generationBest.breakdown,
                };
                noImprovement = 0;
                stagnationRecoveries = 0;
            } else {
                noImprovement += 1;
                if (
                    noImprovement > 0 &&
                    noImprovement % settings.immigrationInterval === 0
                ) {
                    injectImmigrants(population, best, random, true);
                    population.sort(compare);
                    if (
                        (population[0]!.breakdown?.fitness ?? -Infinity) >
                        (best.breakdown?.fitness ?? -Infinity)
                    ) {
                        best = {
                            values: copyValues(population[0]!.values),
                            breakdown: population[0]!.breakdown,
                        };
                        noImprovement = 0;
                        stagnationRecoveries = 0;
                    }
                }
                if (noImprovement >= settings.earlyStoppingGenerations) {
                    const polished = polish(
                        best.values,
                        best.breakdown!,
                        random,
                        Math.min(12, settings.polishSteps),
                    );
                    if (
                        (polished.breakdown?.fitness ?? -Infinity) >
                        (best.breakdown?.fitness ?? -Infinity)
                    ) {
                        best = polished;
                        population[population.length - 1] = {
                            values: copyValues(polished.values),
                            breakdown: polished.breakdown,
                        };
                        population.sort(compare);
                        noImprovement = 0;
                        stagnationRecoveries = 0;
                    } else if (
                        stagnationRecoveries < settings.stagnationRecoveryAttempts
                    ) {
                        stagnationRecoveries += 1;
                        injectImmigrants(population, best, random, true);
                        population.sort(compare);
                        if (
                            (population[0]!.breakdown?.fitness ?? -Infinity) >
                            (best.breakdown?.fitness ?? -Infinity)
                        ) {
                            best = {
                                values: copyValues(population[0]!.values),
                                breakdown: population[0]!.breakdown,
                            };
                        }
                        noImprovement = 0;
                    } else {
                        earlyStopped = true;
                        onProgress?.({
                            restart: restartIndex,
                            generation,
                            best: {
                                genome: valuesToGenome(best.values),
                                breakdown: best.breakdown!,
                            },
                            evalCount,
                            cacheSize: cache.size,
                            earlyStopped: true,
                        });
                        break;
                    }
                }
            }

            if (
                generation === 1 ||
                generation === settings.generations ||
                generation % 10 === 0 ||
                earlyStopped
            ) {
                onProgress?.({
                    restart: restartIndex,
                    generation,
                    best: {
                        genome: valuesToGenome(best.values),
                        breakdown: best.breakdown!,
                    },
                    evalCount,
                    cacheSize: cache.size,
                    earlyStopped,
                });
            }
        }

        const finalPolished = polish(best.values, best.breakdown!, random);
        if (
            (finalPolished.breakdown?.fitness ?? -Infinity) >
            (best.breakdown?.fitness ?? -Infinity)
        ) {
            best = finalPolished;
        }
        return { best, generationsExecuted };
    };

    const baselineValues = genomeToValues(DEFAULT_NEARBY_GENOME);
    const baselineBreakdown = evaluate(baselineValues);
    const baseline: ScoredCandidate = {
        genome: valuesToGenome(baselineValues),
        breakdown: baselineBreakdown,
    };

    const restartBests: ScoredCandidate[] = [];
    let overallBest: InternalCandidate = {
        values: baselineValues,
        breakdown: baselineBreakdown,
    };
    let generationsExecuted = 0;

    for (let restart = 0; restart < settings.restartCount; restart++) {
        const { best, generationsExecuted: gens } = searchOnce(restart);
        generationsExecuted += gens;
        const scored: ScoredCandidate = {
            genome: valuesToGenome(best.values),
            breakdown: best.breakdown!,
        };
        restartBests.push(scored);
        if (
            (best.breakdown?.fitness ?? -Infinity) >
            (overallBest.breakdown?.fitness ?? -Infinity)
        ) {
            overallBest = best;
        }
    }

    return {
        best: {
            genome: valuesToGenome(overallBest.values),
            breakdown: overallBest.breakdown!,
        },
        baseline,
        restarts: restartBests,
        evalCount,
        generationsExecuted,
    };
};
