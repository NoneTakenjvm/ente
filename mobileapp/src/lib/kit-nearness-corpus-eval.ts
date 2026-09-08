/**
 * Offline kit-nearness fitness against an anonymised corpus.
 *
 * Selects visually coherent exact-tag-set kits, holds out members, and scores
 * ranking quality (AUC / top-K) plus competitive exclusivity. Used by the GA.
 */
import type { PhashEntry } from "@/lib/crop-match";
import type {
    AnonymisedCorpusPhoto,
    AnonymisedDerivedKit,
    AnonymisedKitNearnessCorpus,
} from "@/lib/kit-nearness-corpus-export";
import { FastNearnessScorer } from "@/lib/kit-nearness-corpus-eval-fast";
import {
    kitDistance,
    kitNearnessDistance,
    pickKitMedoids,
    type KitMedoid,
} from "@/lib/kit-nearness-sort";
import {
    hammingDistancePacked,
    parseDHashHex,
    type PackedDHash,
} from "@/lib/phash";

export type NearnessGenome = {
    colorRadius: number;
    colorBonus: number;
    structureGate: number;
    rivalTau: number;
    rivalLambda: number;
    maxMedoids: number;
    minSeparation: number;
};

export type KitFold = {
    kitId: string;
    tags: string[];
    seedIds: number[];
    /** All held-out exact-set members (hashed). */
    holdoutIds: number[];
    /**
     * Holdouts within {@link visualPositiveThreshold} of seed medoids under
     * structure-only distance — the ranking positives (near-dup siblings).
     */
    visualHoldoutIds: number[];
    /** Mean pairwise primary-dHash among hashed members. */
    meanPairwise: number;
};

export type FitnessBreakdown = {
    fitness: number;
    holdoutAuc: number;
    holdoutTopK: number;
    exclAuc: number;
    softRivalLift: number;
    kitCount: number;
};

export type CorpusEvalContext = {
    entries: Map<number, PhashEntry>;
    hashedIds: number[];
    folds: KitFold[];
    /** Pre-picked rival fold indices per fold (distant kits). */
    rivalFoldIndex: number[];
    /** Soft-rival fold indices (visually nearer kits) for over-penalty guard. */
    softRivalFoldIndex: number[];
    /** kitDistance(self, softRival) using default medoids — skip soft work when large. */
    softRivalDelta: number[];
    negativePool: number[];
    /** Packed fast scorer — preferred path for GA. */
    fastScorer: FastNearnessScorer;
};

export const DEFAULT_NEARBY_GENOME: NearnessGenome = {
    colorRadius: 8,
    colorBonus: 1.35,
    structureGate: 22,
    rivalTau: 5,
    rivalLambda: 4,
    maxMedoids: 2,
    minSeparation: 10,
};

const mulberry32 = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return (): number => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };
};

const shuffleInPlace = <T>(items: T[], random: () => number): void => {
    for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const tmp = items[i]!;
        items[i] = items[j]!;
        items[j] = tmp;
    }
};

const primaryPacked = (entry: PhashEntry): PackedDHash | undefined => {
    const hex = entry.hashes[0];
    if (!hex) {
        return undefined;
    }
    return parseDHashHex(hex);
};

/**
 * Mean pairwise Hamming on primary dHash for up to `sampleCap` ids.
 */
export const meanPairwisePrimaryDistance = (
    ids: readonly number[],
    entries: ReadonlyMap<number, PhashEntry>,
    sampleCap: number = 40,
): number => {
    const packed: PackedDHash[] = [];
    for (const id of ids) {
        const entry = entries.get(id);
        if (!entry) {
            continue;
        }
        const p = primaryPacked(entry);
        if (p) {
            packed.push(p);
        }
        if (packed.length >= sampleCap) {
            break;
        }
    }
    if (packed.length < 2) {
        return Number.POSITIVE_INFINITY;
    }
    let sum = 0;
    let n = 0;
    for (let i = 0; i < packed.length; i++) {
        for (let j = i + 1; j < packed.length; j++) {
            sum += hammingDistancePacked(packed[i]!, packed[j]!);
            n += 1;
        }
    }
    return n === 0 ? Number.POSITIVE_INFINITY : sum / n;
};

const photoHasExactTags = (
    photo: AnonymisedCorpusPhoto,
    kitTags: readonly string[],
): boolean => {
    if (photo.tags.length !== kitTags.length) {
        return false;
    }
    const have = new Set(photo.tags);
    return kitTags.every((t) => have.has(t));
};

/**
 * Build a reusable eval context from a loaded corpus.
 *
 * Exact tag kits in a real library are rarely dHash-coherent. Folds therefore
 * keep large kits and treat as positives only holdouts that are already near
 * the seed medoids (visual near-dup siblings that share the kit tags).
 */
export const buildCorpusEvalContext = (
    corpus: AnonymisedKitNearnessCorpus,
    options?: {
        minCount?: number;
        maxFolds?: number;
        foldSeed?: number;
        seedFraction?: number;
        negativePoolSize?: number;
        /** Max structure distance seed→holdout to count as a visual positive. */
        visualPositiveThreshold?: number;
        minVisualPositives?: number;
        maxSeedsPerFold?: number;
        maxVisualPositivesPerFold?: number;
    },
): CorpusEvalContext => {
    const minCount = options?.minCount ?? 20;
    const maxFolds = options?.maxFolds ?? 12;
    const foldSeed = options?.foldSeed ?? 42;
    const seedFraction = options?.seedFraction ?? 0.6;
    const negativePoolSize = options?.negativePoolSize ?? 180;
    const visualPositiveThreshold = options?.visualPositiveThreshold ?? 14;
    const minVisualPositives = options?.minVisualPositives ?? 3;

    const entries = new Map<number, PhashEntry>();
    const hashedIds: number[] = [];
    for (const photo of corpus.photos) {
        if (!photo.hashes.length) {
            continue;
        }
        const entry: PhashEntry = { hashes: [...photo.hashes] };
        if (photo.color) {
            entry.color = photo.color;
        }
        entries.set(photo.id, entry);
        hashedIds.push(photo.id);
    }

    const random = mulberry32(foldSeed);
    const candidates: KitFold[] = [];
    for (const kit of corpus.derivedKits as AnonymisedDerivedKit[]) {
        if (kit.count < minCount || kit.tags.length < 2) {
            continue;
        }
        const members = corpus.photos
            .filter(
                (p) =>
                    photoHasExactTags(p, kit.tags) && entries.has(p.id),
            )
            .map((p) => p.id);
        if (members.length < minCount) {
            continue;
        }
        const meanPairwise = meanPairwisePrimaryDistance(members, entries);
        const shuffled = [...members];
        shuffleInPlace(shuffled, random);
        const seedCount = Math.max(
            2,
            Math.min(
                members.length - 2,
                Math.floor(members.length * seedFraction),
            ),
        );
        const seedIds = shuffled.slice(0, seedCount);
        const holdoutIds = shuffled.slice(seedCount);
        if (holdoutIds.length < 2 || seedIds.length < 2) {
            continue;
        }
        // Structure-only medoids for labelling visual positives (no color knobs).
        const labelMedoids = pickKitMedoids(seedIds, entries, {
            maxMedoids: 6,
            minSeparation: 10,
        });
        if (!labelMedoids.length) {
            continue;
        }
        const visualHoldoutIds = holdoutIds.filter((id) => {
            const d = kitNearnessDistance(
                id,
                labelMedoids,
                entries,
                0,
                0,
                0,
            );
            return Number.isFinite(d) && d <= visualPositiveThreshold;
        });
        if (visualHoldoutIds.length < minVisualPositives) {
            continue;
        }
        // Cap seed / positive sizes so pickKitMedoids + scoring stay GA-cheap.
        const cappedSeeds = seedIds.slice(0, options?.maxSeedsPerFold ?? 60);
        let cappedVisual = visualHoldoutIds;
        const maxVisual = options?.maxVisualPositivesPerFold ?? 32;
        if (cappedVisual.length > maxVisual) {
            const vis = [...cappedVisual];
            shuffleInPlace(vis, random);
            cappedVisual = vis.slice(0, maxVisual);
        }
        candidates.push({
            kitId: kit.id,
            tags: [...kit.tags],
            seedIds: cappedSeeds,
            holdoutIds,
            visualHoldoutIds: cappedVisual,
            meanPairwise,
        });
    }

    // Prefer kits with more visual positives, then tighter pairwise.
    candidates.sort(
        (a, b) =>
            b.visualHoldoutIds.length - a.visualHoldoutIds.length ||
            a.meanPairwise - b.meanPairwise,
    );
    const folds = candidates.slice(0, maxFolds);

    const foldMedoids: KitMedoid[][] = folds.map((fold) =>
        pickKitMedoids(fold.seedIds, entries, {
            maxMedoids: DEFAULT_NEARBY_GENOME.maxMedoids,
            minSeparation: DEFAULT_NEARBY_GENOME.minSeparation,
        }));

    const rivalFoldIndex: number[] = [];
    const softRivalFoldIndex: number[] = [];
    const softRivalDelta: number[] = [];
    for (let i = 0; i < folds.length; i++) {
        let bestFar = -1;
        let bestFarDist = -1;
        let bestNear = -1;
        let bestNearDist = Number.POSITIVE_INFINITY;
        const self = foldMedoids[i]!;
        for (let j = 0; j < folds.length; j++) {
            if (i === j || !foldMedoids[j]!.length || !self.length) {
                continue;
            }
            const d = kitDistance(self, foldMedoids[j]!);
            if (d > bestFarDist) {
                bestFarDist = d;
                bestFar = j;
            }
            if (d < bestNearDist && d > 0) {
                bestNearDist = d;
                bestNear = j;
            }
        }
        rivalFoldIndex.push(bestFar);
        softRivalFoldIndex.push(bestNear >= 0 ? bestNear : bestFar);
        softRivalDelta.push(
            bestNear >= 0 ? bestNearDist : Number.POSITIVE_INFINITY,
        );
    }

    const memberSet = new Set<number>();
    for (const fold of folds) {
        for (const id of fold.seedIds) {
            memberSet.add(id);
        }
        for (const id of fold.holdoutIds) {
            memberSet.add(id);
        }
    }
    const negCandidates = hashedIds.filter((id) => !memberSet.has(id));
    shuffleInPlace(negCandidates, random);
    const negativePool = negCandidates.slice(0, negativePoolSize);

    return {
        entries,
        hashedIds,
        folds,
        rivalFoldIndex,
        softRivalFoldIndex,
        softRivalDelta,
        negativePool,
        fastScorer: new FastNearnessScorer({
            entries,
            folds,
            rivalFoldIndex,
            softRivalDelta,
            negativePool,
        }),
    };
};

/**
 * Evaluate one genome — delegates to {@link FastNearnessScorer}.
 */
export const evaluateNearnessGenome = (
    ctx: CorpusEvalContext,
    genome: NearnessGenome,
    _medoidCache?: Map<string, KitMedoid[]>,
): FitnessBreakdown => ctx.fastScorer.evaluate(genome);
