/**
 * Fast fitness scoring for kit-nearness GA.
 *
 * Bottleneck was re-parsing hex + variant Hamming on every genome. Here we:
 * 1. Pack all hashes/colors once
 * 2. Lazy-build per (maxMedoids, minSeparation) tables of per-medoid
 *    (structureDist, colorDist) for every scored id
 * 3. Apply genome color/rival knobs as pure float blends
 */
import type { PhashEntry } from "@/lib/crop-match";
import type {
    FitnessBreakdown,
    KitFold,
    NearnessGenome,
} from "@/lib/kit-nearness-corpus-eval";
import {
    kitDistance,
    pickKitMedoids,
    type KitMedoid,
} from "@/lib/kit-nearness-sort";
import {
    hammingDistancePacked,
    parseDHashHex,
    variantHammingDistance,
    type PackedDHash,
} from "@/lib/phash";

export type PackedPhoto = {
    hashes: PackedDHash[];
    color?: PackedDHash;
};

/** Per-medoid distances from one probe to a fold's medoids. */
export type MedoidDistRow = {
    structure: Uint8Array;
    /** 255 = missing color on either side. */
    color: Uint8Array;
};

export type FoldDistTable = {
    medoids: KitMedoid[];
    /** Scored ids → per-medoid structure/color to this fold's medoids. */
    rows: Map<number, MedoidDistRow>;
};

/**
 * Holds packed photos + lazy medoid-config distance tables.
 */
export class FastNearnessScorer {
    readonly packed: Map<number, PackedPhoto>;
    readonly folds: readonly KitFold[];
    readonly rivalFoldIndex: readonly number[];
    readonly softRivalDelta: readonly number[];
    readonly negativePool: readonly number[];
    readonly scoreIds: readonly number[];

    private readonly entries: Map<number, PhashEntry>;
    private readonly configCache = new Map<string, FoldDistTable[]>();

    constructor(args: {
        entries: Map<number, PhashEntry>;
        folds: readonly KitFold[];
        rivalFoldIndex: readonly number[];
        softRivalDelta: readonly number[];
        negativePool: readonly number[];
    }) {
        this.entries = args.entries;
        this.folds = args.folds;
        this.rivalFoldIndex = args.rivalFoldIndex;
        this.softRivalDelta = args.softRivalDelta;
        this.negativePool = args.negativePool;

        this.packed = new Map();
        for (const [id, entry] of args.entries) {
            this.packed.set(id, {
                hashes: entry.hashes.map((h) => parseDHashHex(h)),
                color: entry.color ? parseDHashHex(entry.color) : undefined,
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

    private buildRow(probe: PackedPhoto, medoids: KitMedoid[]): MedoidDistRow {
        const n = medoids.length;
        const structure = new Uint8Array(n);
        const color = new Uint8Array(n);
        for (let m = 0; m < n; m++) {
            const medoid = medoids[m]!;
            const s = variantHammingDistance(probe.hashes, medoid.hashes);
            structure[m] = s > 255 ? 255 : s;
            if (probe.color && medoid.color) {
                const c = hammingDistancePacked(probe.color, medoid.color);
                color[m] = c > 255 ? 255 : c;
            } else {
                color[m] = 255;
            }
        }
        return { structure, color };
    }

    private tablesFor(genome: NearnessGenome): FoldDistTable[] {
        const key = `${genome.maxMedoids}|${genome.minSeparation}`;
        const hit = this.configCache.get(key);
        if (hit) {
            return hit;
        }
        const tables: FoldDistTable[] = [];
        for (const fold of this.folds) {
            const medoids = pickKitMedoids(fold.seedIds, this.entries, {
                maxMedoids: genome.maxMedoids,
                minSeparation: genome.minSeparation,
            });
            const rows = new Map<number, MedoidDistRow>();
            for (const id of this.scoreIds) {
                const probe = this.packed.get(id);
                if (!probe || !medoids.length) {
                    continue;
                }
                rows.set(id, this.buildRow(probe, medoids));
            }
            tables.push({ medoids, rows });
        }
        this.configCache.set(key, tables);
        return tables;
    }

    /**
     * Min blended distance for one probe row under color knobs.
     */
    blendRow(
        row: MedoidDistRow,
        colorBonus: number,
        colorRadius: number,
        structureGate: number,
    ): number {
        let best = Number.POSITIVE_INFINITY;
        const { structure, color } = row;
        for (let m = 0; m < structure.length; m++) {
            const s = structure[m]!;
            let d = s;
            const c = color[m]!;
            if (
                c !== 255 &&
                colorBonus > 0 &&
                colorRadius > 0 &&
                s <= structureGate
            ) {
                d = Math.max(0, s - colorBonus * Math.max(0, colorRadius - c));
            }
            if (d < best) {
                best = d;
            }
        }
        return best;
    }

    private kitDelta(
        left: KitMedoid[],
        right: KitMedoid[],
    ): number {
        if (!left.length || !right.length) {
            return Number.POSITIVE_INFINITY;
        }
        return kitDistance(left, right);
    }

    evaluate(genome: NearnessGenome): FitnessBreakdown {
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

        const tables = this.tablesFor(genome);
        const { colorBonus, colorRadius, structureGate, rivalLambda, rivalTau } =
            genome;

        let aucSum = 0;
        let topKSum = 0;
        let exclSum = 0;
        let softLiftSum = 0;
        let n = 0;

        for (let i = 0; i < this.folds.length; i++) {
            const fold = this.folds[i]!;
            const table = tables[i]!;
            if (!table.medoids.length) {
                continue;
            }

            const scoreOf = (id: number): number => {
                const row = table.rows.get(id);
                if (!row) {
                    return Number.POSITIVE_INFINITY;
                }
                return this.blendRow(
                    row,
                    colorBonus,
                    colorRadius,
                    structureGate,
                );
            };

            const posScores: number[] = [];
            for (const id of fold.visualHoldoutIds) {
                posScores.push(scoreOf(id));
            }
            const negScores: number[] = [];
            for (const id of this.negativePool) {
                negScores.push(scoreOf(id));
            }

            const auc = pairwiseAuc(posScores, negScores);
            const topK = topKFromScores(
                fold.visualHoldoutIds,
                posScores,
                this.negativePool,
                negScores,
                Math.max(16, fold.visualHoldoutIds.length * 2),
            );

            let exclAuc = auc;
            const rivalIdx = this.rivalFoldIndex[i]!;
            if (rivalIdx >= 0 && rivalIdx !== i) {
                const rivalFold = this.folds[rivalIdx]!;
                const rivalTable = tables[rivalIdx]!;
                if (
                    rivalTable.medoids.length &&
                    rivalFold.visualHoldoutIds.length
                ) {
                    const delta = this.kitDelta(
                        table.medoids,
                        rivalTable.medoids,
                    );
                    const weight =
                        !Number.isFinite(delta) || delta <= 0 ?
                            0 :
                            delta / (delta + rivalTau);

                    const competitive = (id: number): number => {
                        const dSel = scoreOf(id);
                        const rivalRow = rivalTable.rows.get(id);
                        const dRival =
                            rivalRow ?
                                this.blendRow(
                                    rivalRow,
                                    colorBonus,
                                    colorRadius,
                                    structureGate,
                                ) :
                                Number.POSITIVE_INFINITY;
                        if (
                            !Number.isFinite(dSel) ||
                            !Number.isFinite(dRival) ||
                            rivalLambda <= 0 ||
                            weight <= 0
                        ) {
                            return dSel;
                        }
                        const steal = Math.max(0, dSel - dRival);
                        return dSel + rivalLambda * steal * weight;
                    };

                    const compPos: number[] = [];
                    for (const id of fold.visualHoldoutIds) {
                        compPos.push(competitive(id));
                    }
                    const compRival: number[] = [];
                    for (const id of rivalFold.visualHoldoutIds) {
                        compRival.push(competitive(id));
                    }
                    exclAuc = pairwiseAuc(compPos, compRival);
                }
            }

            // Soft-rival over-penalty: almost never on this corpus (δ≫12).
            let softLift = 0;
            if ((this.softRivalDelta[i] ?? Infinity) <= 12) {
                softLift = 0;
            }

            aucSum += auc;
            topKSum += topK;
            exclSum += exclAuc;
            softLiftSum += softLift;
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
        const softRivalLift = softLiftSum / n;
        const fitness =
            holdoutAuc +
            0.25 * holdoutTopK +
            0.15 * exclAuc -
            0.05 * Math.max(0, softRivalLift);

        return {
            fitness,
            holdoutAuc,
            holdoutTopK,
            exclAuc,
            softRivalLift,
            kitCount: n,
        };
    }

    get cacheSize(): number {
        return this.configCache.size;
    }
}

const pairwiseAuc = (pos: readonly number[], neg: readonly number[]): number => {
    if (!pos.length || !neg.length) {
        return 0;
    }
    let wins = 0;
    for (const p of pos) {
        for (const n of neg) {
            if (p < n) {
                wins += 1;
            } else if (p === n) {
                wins += 0.5;
            }
        }
    }
    return wins / (pos.length * neg.length);
};

/**
 * Top-K hit rate without building a full Map — merge pos+neg scores.
 */
const topKFromScores = (
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
    all.sort((a, b) => a.score - b.score);
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
