/**
 * Majority-kit likeness eval: score = fraction of kit seeds within a Hamming
 * threshold (optionally floored). Higher is better. Used to test the
 * “similar to >y% of the kit” approach offline before baking into gallery.
 */
import type { PhashEntry } from "@/lib/crop-match";
import type {
    AnonymisedKitNearnessCorpus,
} from "@/lib/kit-nearness-corpus-export";
import {
    buildCorpusEvalContext,
    type CorpusEvalContext,
    type FitnessBreakdown,
    type KitFold,
} from "@/lib/kit-nearness-corpus-eval";
import {
    parseDHashHex,
    variantHammingDistance,
    type PackedDHash,
} from "@/lib/phash";

export type MajorityGenome = {
    /** Max structure Hamming to count a kit seed as a match. */
    matchThreshold: number;
    /**
     * If the match fraction is below this, score is treated as 0.
     * 0 = no floor (pure fraction ranking).
     */
    minMatchFraction: number;
    /** Soft steal penalty vs rival kit fraction (0 = no push-down). */
    rivalLambda: number;
    /** Cap how many kit seeds we compare against (speed + noise). */
    maxSeeds: number;
};

export const DEFAULT_MAJORITY_GENOME: MajorityGenome = {
    matchThreshold: 12,
    minMatchFraction: 0,
    rivalLambda: 0,
    maxSeeds: 80,
};

export type MajorityEvalContext = {
    folds: KitFold[];
    rivalFoldIndex: number[];
    negativePool: number[];
    scorer: FastMajorityScorer;
};

type PackedPhoto = {
    hashes: PackedDHash[];
};

/**
 * Build folds the same way as medoid eval, then wrap a majority scorer.
 */
export const buildMajorityEvalContext = (
    corpus: AnonymisedKitNearnessCorpus,
    options?: Parameters<typeof buildCorpusEvalContext>[1],
): MajorityEvalContext => {
    const base: CorpusEvalContext = buildCorpusEvalContext(corpus, options);
    return {
        folds: base.folds,
        rivalFoldIndex: base.rivalFoldIndex,
        negativePool: base.negativePool,
        scorer: new FastMajorityScorer({
            entries: base.entries,
            folds: base.folds,
            rivalFoldIndex: base.rivalFoldIndex,
            negativePool: base.negativePool,
        }),
    };
};

export const evaluateMajorityGenome = (
    ctx: MajorityEvalContext,
    genome: MajorityGenome,
): FitnessBreakdown => ctx.scorer.evaluate(genome);

/**
 * Precomputes probe→seed structure distances; genome only thresholds/counts.
 */
export class FastMajorityScorer {
    private readonly packed = new Map<number, PackedPhoto>();
    private readonly folds: readonly KitFold[];
    private readonly rivalFoldIndex: readonly number[];
    private readonly negativePool: readonly number[];
    private readonly scoreIds: readonly number[];
    /** maxSeeds → per-fold Map<scoreId, Uint8Array distances to seeds> */
    private readonly distCache = new Map<
        number,
        Map<number, Uint8Array>[]
    >();

    constructor(args: {
        entries: Map<number, PhashEntry>;
        folds: readonly KitFold[];
        rivalFoldIndex: readonly number[];
        negativePool: readonly number[];
    }) {
        this.folds = args.folds;
        this.rivalFoldIndex = args.rivalFoldIndex;
        this.negativePool = args.negativePool;

        for (const [id, entry] of args.entries) {
            if (!entry.hashes.length) {
                continue;
            }
            this.packed.set(id, {
                hashes: entry.hashes.map((h) => parseDHashHex(h)),
            });
        }

        const idSet = new Set<number>();
        for (const fold of args.folds) {
            for (const id of fold.visualHoldoutIds) {
                idSet.add(id);
            }
        }
        for (const id of args.negativePool) {
            idSet.add(id);
        }
        this.scoreIds = [...idSet];
    }

    private tablesFor(maxSeeds: number): Map<number, Uint8Array>[] {
        const key = Math.max(2, Math.round(maxSeeds));
        const hit = this.distCache.get(key);
        if (hit) {
            return hit;
        }
        const tables: Map<number, Uint8Array>[] = [];
        for (const fold of this.folds) {
            const seedIds = fold.seedIds
                .filter((id) => this.packed.has(id))
                .slice(0, key);
            const seedPacked = seedIds.map((id) => this.packed.get(id)!);
            const rows = new Map<number, Uint8Array>();
            for (const id of this.scoreIds) {
                const probe = this.packed.get(id);
                if (!probe || !seedPacked.length) {
                    continue;
                }
                const dists = new Uint8Array(seedPacked.length);
                for (let s = 0; s < seedPacked.length; s++) {
                    const d = variantHammingDistance(
                        probe.hashes,
                        seedPacked[s]!.hashes,
                    );
                    dists[s] = d > 255 ? 255 : d;
                }
                rows.set(id, dists);
            }
            tables.push(rows);
        }
        this.distCache.set(key, tables);
        return tables;
    }

    private fraction(
        dists: Uint8Array | undefined,
        threshold: number,
        minFraction: number,
    ): number {
        if (!dists?.length) {
            return 0;
        }
        let hits = 0;
        for (const dist of dists) {
            if (dist <= threshold) {
                hits += 1;
            }
        }
        const frac = hits / dists.length;
        return frac < minFraction ? 0 : frac;
    }

    evaluate(genome: MajorityGenome): FitnessBreakdown {
        if (!this.folds.length) {
            return {
                fitness: 0,
                holdoutAuc: 0,
                holdoutTopK: 0,
                exclAuc: 0,
                softRivalLift: 0,
                kitCount: 0,
            };
        }

        const tables = this.tablesFor(genome.maxSeeds);
        const threshold = Math.round(genome.matchThreshold);
        const minFrac = genome.minMatchFraction;
        const rivalLambda = genome.rivalLambda;

        let aucSum = 0;
        let topKSum = 0;
        let exclSum = 0;
        let n = 0;

        for (let i = 0; i < this.folds.length; i++) {
            const fold = this.folds[i]!;
            const table = tables[i]!;

            const scoreOf = (id: number): number =>
                this.fraction(table.get(id), threshold, minFrac);

            const posScores: number[] = [];
            for (const id of fold.visualHoldoutIds) {
                posScores.push(scoreOf(id));
            }
            const negScores: number[] = [];
            for (const id of this.negativePool) {
                negScores.push(scoreOf(id));
            }

            const auc = pairwiseAucHigherBetter(posScores, negScores);
            const topK = topKHigherBetter(
                fold.visualHoldoutIds,
                posScores,
                this.negativePool,
                negScores,
                Math.max(16, fold.visualHoldoutIds.length * 2),
            );

            let exclAuc = auc;
            const rivalIdx = this.rivalFoldIndex[i]!;
            if (rivalIdx >= 0 && rivalIdx !== i && rivalLambda > 0) {
                const rivalFold = this.folds[rivalIdx]!;
                const rivalTable = tables[rivalIdx]!;
                const competitive = (id: number): number => {
                    const sel = scoreOf(id);
                    const rival = this.fraction(
                        rivalTable.get(id),
                        threshold,
                        minFrac,
                    );
                    const steal = Math.max(0, rival - sel);
                    return sel - rivalLambda * steal;
                };
                const compPos: number[] = [];
                for (const id of fold.visualHoldoutIds) {
                    compPos.push(competitive(id));
                }
                const compRival: number[] = [];
                for (const id of rivalFold.visualHoldoutIds) {
                    compRival.push(competitive(id));
                }
                exclAuc = pairwiseAucHigherBetter(compPos, compRival);
            } else if (rivalIdx >= 0 && rivalIdx !== i) {
                // No push-down: exclusivity = can selected-kit fraction separate
                // selected positives from rival positives?
                const rivalFold = this.folds[rivalIdx]!;
                const rivalPos: number[] = [];
                for (const id of rivalFold.visualHoldoutIds) {
                    rivalPos.push(scoreOf(id));
                }
                exclAuc = pairwiseAucHigherBetter(posScores, rivalPos);
            }

            aucSum += auc;
            topKSum += topK;
            exclSum += exclAuc;
            n += 1;
        }

        if (n === 0) {
            return {
                fitness: 0,
                holdoutAuc: 0,
                holdoutTopK: 0,
                exclAuc: 0,
                softRivalLift: 0,
                kitCount: 0,
            };
        }

        const holdoutAuc = aucSum / n;
        const holdoutTopK = topKSum / n;
        const exclAuc = exclSum / n;
        const fitness =
            holdoutAuc + 0.25 * holdoutTopK + 0.15 * exclAuc;

        return {
            fitness,
            holdoutAuc,
            holdoutTopK,
            exclAuc,
            softRivalLift: 0,
            kitCount: n,
        };
    }
}

const pairwiseAucHigherBetter = (
    pos: readonly number[],
    neg: readonly number[],
): number => {
    if (!pos.length || !neg.length) {
        return 0;
    }
    let wins = 0;
    for (const p of pos) {
        for (const n of neg) {
            if (p > n) {
                wins += 1;
            } else if (p === n) {
                wins += 0.5;
            }
        }
    }
    return wins / (pos.length * neg.length);
};

const topKHigherBetter = (
    posIds: readonly number[],
    posScores: readonly number[],
    negIds: readonly number[],
    negScores: readonly number[],
    k: number,
): number => {
    if (!posIds.length) {
        return 0;
    }
    const all: { id: number; score: number }[] = [];
    for (let i = 0; i < posIds.length; i++) {
        all.push({ id: posIds[i]!, score: posScores[i]! });
    }
    for (let i = 0; i < negIds.length; i++) {
        all.push({ id: negIds[i]!, score: negScores[i]! });
    }
    all.sort((a, b) => b.score - a.score);
    const top = new Set(
        all.slice(0, Math.max(1, k)).map((entry) => entry.id),
    );
    let hits = 0;
    for (const id of posIds) {
        if (top.has(id)) {
            hits += 1;
        }
    }
    return hits / posIds.length;
};
