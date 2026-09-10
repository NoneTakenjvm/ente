/**
 * Holdout grid search for one kit's CLIP nearness genome.
 *
 * The long GA is gone: on MobileCLIP-S2 with production rivals (all other
 * saved kits), centroid + λ=16 + τ=0.02 is already at the plateau. A 15-cell
 * centroid λ×τ grid is enough to catch a rare kit that wants something else.
 */
import {
    DEFAULT_KIT_EMBEDDING_GENOME,
    KIT_NEARNESS_TUNE_MIN_LIFT,
    KIT_NEARNESS_TUNE_MIN_MEMBERS,
    KIT_NEARNESS_TUNE_VERSION,
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
    phase: "setup" | "search" | "done";
    /** Human-readable status line. */
    label: string;
    /** Completed fitness evaluations. */
    current: number;
    /** Estimated total evaluations. */
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

/** Centroid-only λ×τ cells. Medoids overfit on holdout in S2 research. */
const TUNE_LAMBDAS = [0, 8, 12, 16, 24] as const;
const TUNE_TAUS = [0.02, 0.06, 0.12] as const;

const genomeKey = (values: number[]): string =>
    values.map((v) => v.toFixed(4)).join("|");

const yieldToUi = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

const throwIfAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) {
        throw new DOMException("Kit nearness tune aborted", "AbortError");
    }
};

const tuneGrid = (): KitEmbeddingNearnessGenome[] => {
    const cells: KitEmbeddingNearnessGenome[] = [];
    for (const rivalLambda of TUNE_LAMBDAS) {
        for (const rivalTau of TUNE_TAUS) {
            cells.push(
                clampKitEmbeddingNearnessGenome({
                    ...DEFAULT_KIT_EMBEDDING_GENOME,
                    useCentroid: 1,
                    rivalLambda,
                    rivalTau,
                }),
            );
        }
    }
    return cells;
};

/**
 * Run a holdout grid for one kit. Returns a persistable result only when the
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

    const fold = buildKitEmbeddingEvalFold(
        libraryFiles,
        kitTags,
        embeddings,
        rivalKits.filter((kit) => kit.id !== options.kitId),
        {
            random: (() => {
                let state = seed >>> 0;
                return (): number => {
                    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
                    return state / 0x1_0000_0000;
                };
            })(),
            negativePoolSize: 220,
            seedFraction: 0.6,
        },
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

    const grid = tuneGrid();
    const total = grid.length + 1;
    let evalCount = 0;
    const cache = new Map<string, KitEmbeddingFitnessBreakdown>();

    const evaluate = async (
        genome: KitEmbeddingNearnessGenome,
    ): Promise<KitEmbeddingFitnessBreakdown> => {
        throwIfAborted(signal);
        const values = kitEmbeddingGenomeToValues(genome);
        const key = genomeKey(values);
        const hit = cache.get(key);
        if (hit) {
            return hit;
        }
        const breakdown = evaluateKitEmbeddingGenome(
            fold,
            embeddings,
            valuesToKitEmbeddingGenome(values),
            rivalGenomeList,
        );
        cache.set(key, breakdown);
        evalCount += 1;
        await yieldToUi();
        return breakdown;
    };

    const baseline = await evaluate(DEFAULT_KIT_EMBEDDING_GENOME);
    let bestGenome = DEFAULT_KIT_EMBEDDING_GENOME;
    let bestBreakdown = baseline;

    report({
        phase: "search",
        label: `Baseline fitness ${(baseline.fitness * 100).toFixed(1)}% — grid…`,
        current: evalCount,
        total,
        bestFitness: baseline.fitness,
        baselineFitness: baseline.fitness,
    });

    for (const genome of grid) {
        const breakdown = await evaluate(genome);
        if (
            breakdown.fitness > bestBreakdown.fitness ||
            (breakdown.fitness === bestBreakdown.fitness &&
                breakdown.holdoutAuc > bestBreakdown.holdoutAuc)
        ) {
            bestGenome = genome;
            bestBreakdown = breakdown;
        }
        report({
            phase: "search",
            label: `Grid ${evalCount}/${total} — best ${(bestBreakdown.fitness * 100).toFixed(1)}%`,
            current: Math.min(evalCount, total),
            total,
            bestFitness: bestBreakdown.fitness,
            baselineFitness: baseline.fitness,
        });
    }

    const genome = clampKitEmbeddingNearnessGenome(bestGenome);
    const lift = bestBreakdown.fitness - baseline.fitness;

    report({
        phase: "done",
        label:
            lift >= KIT_NEARNESS_TUNE_MIN_LIFT ?
                `Kept tune (+${(lift * 100).toFixed(1)} pp vs default)` :
                `No gain over default (Δ ${(lift * 100).toFixed(1)} pp) — keeping global`,
        current: total,
        total,
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
        tuneVersion: KIT_NEARNESS_TUNE_VERSION,
    };
};

export type { KitEmbeddingEvalFold };
