/**
 * GA over {@link MajorityGenome} — same Emperor-style loop as medoid GA.
 */
import {
    DEFAULT_MAJORITY_GENOME,
    evaluateMajorityGenome,
    type MajorityEvalContext,
    type MajorityGenome,
} from "@/lib/kit-nearness-majority-eval";
import type { FitnessBreakdown } from "@/lib/kit-nearness-corpus-eval";
import {
    DEFAULT_GA_SETTINGS,
    type GaSettings,
    type GaProgressEvent,
    type ScoredCandidate,
    type GaSearchResult,
} from "./kit-nearness-ga-search";

type GeneSpec = {
    key: keyof MajorityGenome;
    lo: number;
    hi: number;
    integer: boolean;
};

const GENE_SPECS: readonly GeneSpec[] = [
    { key: "matchThreshold", lo: 4, hi: 22, integer: true },
    { key: "minMatchFraction", lo: 0, hi: 0.45, integer: false },
    { key: "rivalLambda", lo: 0, hi: 4, integer: false },
    { key: "maxSeeds", lo: 20, hi: 120, integer: true },
];

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

const genomeToValues = (genome: MajorityGenome): number[] =>
    GENE_SPECS.map((spec) => genome[spec.key]);

const valuesToGenome = (values: number[]): MajorityGenome => {
    const genome = { ...DEFAULT_MAJORITY_GENOME };
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
        let next = clamp(v + (random() * 2 - 1) * span * scale, spec.lo, spec.hi);
        if (spec.integer) {
            next = Math.round(next);
        }
        return next;
    });

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
            next = next + (random() + random() + random() - 1.5) * span * 0.08;
        } else if (mode === 1) {
            next = next + (random() * 2 - 1) * span * 0.35;
        } else if (mode === 2) {
            next = spec.lo + random() * span;
        } else if (mode === 3) {
            const def = DEFAULT_MAJORITY_GENOME[spec.key];
            next = next + (def - next) * (0.3 + random() * 0.5);
        } else {
            next =
                next +
                (random() < 0.5 ? -1 : 1) * (spec.integer ? 1 : span * 0.05);
        }
        next = clamp(next, spec.lo, spec.hi);
        values[i] = spec.integer ? Math.round(next) : next;
    }
};

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
            value =
                random() < weightA ?
                    a[i]! * t + b[i]! * (1 - t)
                :   b[i]! * t + a[i]! * (1 - t);
        }
        value = clamp(value, spec.lo, spec.hi);
        child.push(spec.integer ? Math.round(value) : value);
    }
    return child;
};

export const runMajorityGeneticSearch = (
    ctx: MajorityEvalContext,
    settings: GaSettings = DEFAULT_GA_SETTINGS,
    onProgress?: (event: GaProgressEvent & { genome: MajorityGenome }) => void,
): GaSearchResult & { best: ScoredCandidate & { majorityGenome: MajorityGenome } } => {
    const cache = new Map<string, FitnessBreakdown>();
    let evalCount = 0;

    const evaluate = (values: number[]): FitnessBreakdown => {
        const key = genomeKey(values);
        const hit = cache.get(key);
        if (hit) {
            return hit;
        }
        evalCount += 1;
        const breakdown = evaluateMajorityGenome(ctx, valuesToGenome(values));
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
        (b.breakdown?.fitness ?? -Infinity) -
        (a.breakdown?.fitness ?? -Infinity);

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

    const polish = (
        values: number[],
        breakdown: FitnessBreakdown,
        random: () => number,
    ): InternalCandidate => {
        let bestValues = copyValues(values);
        let bestBreakdown = breakdown;
        for (let step = 0; step < settings.polishSteps; step++) {
            const trial = copyValues(bestValues);
            const gene = Math.floor(random() * trial.length);
            const spec = GENE_SPECS[gene]!;
            const span = spec.hi - spec.lo;
            const delta =
                (random() < 0.5 ? -1 : 1) *
                (spec.integer ? 1 : span * (0.02 + random() * 0.06));
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
        return { values: bestValues, breakdown: bestBreakdown };
    };

    const initializePopulation = (random: () => number): InternalCandidate[] => {
        const population: InternalCandidate[] = [];
        const defaults = genomeToValues(DEFAULT_MAJORITY_GENOME);
        population.push({ values: copyValues(defaults), breakdown: null });
        const seedBudget = Math.max(
            4,
            Math.floor(settings.populationSize * 0.35),
        );
        for (let i = 1; i < seedBudget; i++) {
            population.push({
                values: perturbValues(defaults, random, 0.15 + (i % 5) * 0.08),
                breakdown: null,
            });
        }
        while (population.length < settings.populationSize) {
            population.push({ values: randomValues(random), breakdown: null });
        }
        return population;
    };

    const searchOnce = (
        restartIndex: number,
    ): { best: InternalCandidate; generationsExecuted: number } => {
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
        let generationsExecuted = 0;

        for (
            let generation = 1;
            generation <= settings.generations;
            generation++
        ) {
            generationsExecuted = generation;
            const next: InternalCandidate[] = [];
            for (let e = 0; e < settings.eliteCount; e++) {
                const elite = population[e]!;
                next.push({
                    values: copyValues(elite.values),
                    breakdown: elite.breakdown,
                });
            }
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
                    mutateValues(child, settings.mutationRate, random);
                }
                next.push({ values: child, breakdown: null });
            }
            for (const c of next) {
                ensureScored(c);
            }
            next.sort(compare);
            population = next;

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
            } else {
                noImprovement += 1;
            }

            if (
                generation === 1 ||
                generation % 10 === 0 ||
                generation === settings.generations
            ) {
                onProgress?.({
                    restart: restartIndex,
                    generation,
                    best: {
                        genome: valuesToGenome(best.values) as never,
                        breakdown: best.breakdown!,
                    },
                    genome: valuesToGenome(best.values),
                    evalCount,
                    cacheSize: cache.size,
                });
            }

            if (noImprovement >= settings.earlyStoppingGenerations) {
                const polished = polish(best.values, best.breakdown!, random);
                if (
                    (polished.breakdown?.fitness ?? -Infinity) >
                    (best.breakdown?.fitness ?? -Infinity)
                ) {
                    best = polished;
                    noImprovement = 0;
                } else {
                    onProgress?.({
                        restart: restartIndex,
                        generation,
                        best: {
                            genome: valuesToGenome(best.values) as never,
                            breakdown: best.breakdown!,
                        },
                        genome: valuesToGenome(best.values),
                        evalCount,
                        cacheSize: cache.size,
                        earlyStopped: true,
                    });
                    break;
                }
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

    const baselineValues = genomeToValues(DEFAULT_MAJORITY_GENOME);
    const baselineBreakdown = evaluate(baselineValues);
    const baseline: ScoredCandidate = {
        genome: valuesToGenome(baselineValues) as never,
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
            genome: valuesToGenome(best.values) as never,
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

    const majorityGenome = valuesToGenome(overallBest.values);
    return {
        best: {
            genome: majorityGenome as never,
            breakdown: overallBest.breakdown!,
            majorityGenome,
        },
        baseline,
        restarts: restartBests,
        evalCount,
        generationsExecuted,
    };
};
