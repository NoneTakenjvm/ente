/**
 * Single-kit CLIP nearness holdout fitness (in-browser).
 *
 * Holds out embedded kit members, builds prototypes from the rest, and scores
 * whether holdouts rank above random non-members (AUC + top-K). Optional rival
 * kits apply the competitive steal penalty using each rival's stored genome or
 * the global default.
 */
import {
    KIT_EMBEDDING_DIMS,
    type EmbeddingVector,
    type ReadonlyEmbeddingMap,
} from "@/lib/kit-embedding";
import {
    DEFAULT_KIT_EMBEDDING_GENOME,
    type KitEmbeddingNearnessGenome,
} from "@/lib/kit-nearness-embedding-genome";
import {
    buildKitEmbeddingCentroid,
    fileMatchesKitTags,
    kitEmbeddingDistanceCompetitive,
    listKitSeedFiles,
    pickKitEmbeddingMedoids,
} from "@/lib/kit-nearness-sort";
import { isEnteVideoFile } from "@/lib/media-kind";
import type { EnteFile } from "ente-media/file";

export type KitEmbeddingFitnessBreakdown = {
    fitness: number;
    holdoutAuc: number;
    holdoutTopK: number;
    holdoutCount: number;
    negativeCount: number;
};

export type KitEmbeddingEvalFold = {
    seedIds: number[];
    holdoutIds: number[];
    negativeIds: number[];
    /** Rival kit tag sets (other presets) for competitive scoring. */
    rivalSeedIdSets: number[][];
};

export type BuildKitEmbeddingFoldOptions = {
    seedFraction?: number;
    negativePoolSize?: number;
    random?: () => number;
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

/**
 * Mann-Whitney U AUC: fraction of (pos, neg) pairs where pos scores higher.
 */
export const mannWhitneyAuc = (
    positiveScores: readonly number[],
    negativeScores: readonly number[],
): number => {
    if (!positiveScores.length || !negativeScores.length) {
        return 0.5;
    }
    let wins = 0;
    let ties = 0;
    for (const p of positiveScores) {
        for (const n of negativeScores) {
            if (p > n) {
                wins += 1;
            } else if (p === n) {
                ties += 1;
            }
        }
    }
    const total = positiveScores.length * negativeScores.length;
    return (wins + 0.5 * ties) / total;
};

export const topKHitRate = (
    rankedIds: readonly number[],
    positiveSet: ReadonlySet<number>,
    k: number,
): number => {
    if (k <= 0) {
        return 0;
    }
    let hits = 0;
    for (let i = 0; i < k && i < rankedIds.length; i++) {
        if (positiveSet.has(rankedIds[i]!)) {
            hits += 1;
        }
    }
    return hits / k;
};

/**
 * Build prototypes (centroid or medoids) for a genome.
 */
export const buildKitEmbeddingPrototypes = (
    seedIds: readonly number[],
    embeddings: ReadonlyEmbeddingMap,
    genome: KitEmbeddingNearnessGenome = DEFAULT_KIT_EMBEDDING_GENOME,
): EmbeddingVector[] => {
    if (genome.useCentroid >= 0.5) {
        const centroid = buildKitEmbeddingCentroid(seedIds, embeddings);
        return centroid ? [centroid] : [];
    }
    return pickKitEmbeddingMedoids(seedIds, embeddings, {
        maxMedoids: genome.maxMedoids,
        minSeparation: genome.minSeparation,
    }).map((medoid) => medoid.vector);
};

/**
 * Embedded still members of a kit (stable id order).
 */
export const listEmbeddedKitMembers = (
    libraryFiles: readonly EnteFile[],
    kitTags: readonly string[],
    embeddings: ReadonlyEmbeddingMap,
): number[] => {
    const seeds = listKitSeedFiles(libraryFiles, kitTags);
    const ids: number[] = [];
    for (const file of seeds) {
        const vector = embeddings.get(file.id);
        if (vector?.length === KIT_EMBEDDING_DIMS) {
            ids.push(file.id);
        }
    }
    return ids;
};

/**
 * Build one train/holdout fold for a kit.
 */
export const buildKitEmbeddingEvalFold = (
    libraryFiles: readonly EnteFile[],
    kitTags: readonly string[],
    embeddings: ReadonlyEmbeddingMap,
    rivalKits: readonly { tags: readonly string[] }[],
    options?: BuildKitEmbeddingFoldOptions,
): KitEmbeddingEvalFold | undefined => {
    const random = options?.random ?? mulberry32(42);
    const seedFraction = options?.seedFraction ?? 0.6;
    const negativePoolSize = options?.negativePoolSize ?? 200;

    const members = listEmbeddedKitMembers(libraryFiles, kitTags, embeddings);
    if (members.length < 4) {
        return undefined;
    }
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
    if (holdoutIds.length < 2) {
        return undefined;
    }

    const memberSet = new Set(members);
    const negatives: number[] = [];
    for (const file of libraryFiles) {
        if (isEnteVideoFile(file) || memberSet.has(file.id)) {
            continue;
        }
        if (fileMatchesKitTags(file, kitTags)) {
            continue;
        }
        const vector = embeddings.get(file.id);
        if (vector?.length !== KIT_EMBEDDING_DIMS) {
            continue;
        }
        negatives.push(file.id);
    }
    shuffleInPlace(negatives, random);
    const negativeIds = negatives.slice(0, negativePoolSize);
    if (negativeIds.length < 8) {
        return undefined;
    }

    const rivalSeedIdSets: number[][] = [];
    for (const rival of rivalKits) {
        if (!rival.tags.length) {
            continue;
        }
        const rivalMembers = listEmbeddedKitMembers(
            libraryFiles,
            rival.tags,
            embeddings,
        );
        if (rivalMembers.length >= 2) {
            rivalSeedIdSets.push(rivalMembers);
        }
    }

    return { seedIds, holdoutIds, negativeIds, rivalSeedIdSets };
};

/**
 * Score one genome against a fixed fold (higher fitness = better).
 *
 * Competitive distance when rivals exist; plain min-distance otherwise.
 * Ranking score is {@code -distance} so closer holdouts win the AUC.
 */
export const evaluateKitEmbeddingGenome = (
    fold: KitEmbeddingEvalFold,
    embeddings: ReadonlyEmbeddingMap,
    genome: KitEmbeddingNearnessGenome,
    rivalGenomes?: readonly KitEmbeddingNearnessGenome[],
): KitEmbeddingFitnessBreakdown => {
    const selected = buildKitEmbeddingPrototypes(
        fold.seedIds,
        embeddings,
        genome,
    );
    if (!selected.length) {
        return {
            fitness: 0,
            holdoutAuc: 0.5,
            holdoutTopK: 0,
            holdoutCount: fold.holdoutIds.length,
            negativeCount: fold.negativeIds.length,
        };
    }

    const rivalSets: (readonly ArrayLike<number>[])[] = [];
    for (let i = 0; i < fold.rivalSeedIdSets.length; i++) {
        const rivalSeeds = fold.rivalSeedIdSets[i]!;
        const rivalGenome =
            rivalGenomes?.[i] ?? DEFAULT_KIT_EMBEDDING_GENOME;
        const prototypes = buildKitEmbeddingPrototypes(
            rivalSeeds,
            embeddings,
            rivalGenome,
        );
        if (prototypes.length) {
            rivalSets.push(prototypes);
        }
    }

    const scoreOptions = {
        lambda: genome.rivalLambda,
        tau: genome.rivalTau,
    };

    const scoreOf = (fileId: number): number => {
        const distance = kitEmbeddingDistanceCompetitive(
            fileId,
            selected,
            rivalSets,
            embeddings,
            scoreOptions,
        );
        if (!Number.isFinite(distance)) {
            return Number.NEGATIVE_INFINITY;
        }
        return -distance;
    };

    const posScores = fold.holdoutIds.map(scoreOf);
    const negScores = fold.negativeIds.map(scoreOf);
    const holdoutAuc = mannWhitneyAuc(posScores, negScores);

    const candidates = [...fold.holdoutIds, ...fold.negativeIds];
    const ranked = candidates
        .map((id) => ({ id, score: scoreOf(id) }))
        .sort((a, b) => b.score - a.score)
        .map((row) => row.id);
    const k = Math.min(fold.holdoutIds.length, ranked.length);
    const holdoutTopK = topKHitRate(ranked, new Set(fold.holdoutIds), k);

    const fitness = 0.6 * holdoutAuc + 0.4 * holdoutTopK;
    return {
        fitness,
        holdoutAuc,
        holdoutTopK,
        holdoutCount: fold.holdoutIds.length,
        negativeCount: fold.negativeIds.length,
    };
};
