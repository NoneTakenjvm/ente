/**
 * Gallery reorder by visual nearness to a tag kit.
 *
 * Primary path: CLIP embeddings — seed photos are reduced to a few medoids
 * (real photos), then each gallery file is ranked by min cosine distance to
 * those medoids (best / lowest first). Soft exclusive-affinity vs rival kit
 * medoids mirrors the old dHash path.
 *
 * Legacy dHash medoid helpers remain for offline corpus GA / eval harnesses.
 * Files without an embedding sort last.
 */
import type { PhashEntry } from "@/lib/crop-match";
import { KIT_EMBEDDING_DIMS } from "@/lib/kit-embedding";
import {
    hammingDistancePacked,
    parseDHashHex,
    variantHammingDistance,
    type PackedDHash,
} from "@/lib/phash";
import { extractUserTags } from "@/lib/tags";
import { isEnteVideoFile } from "@/lib/media-kind";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import type { EnteFile } from "ente-media/file";

/** Cap how many visual modes we keep per kit. */
export const MAX_KIT_MEDOIDS = 2;

/** Cap seed sample size so medoid picking stays cheap on large kits. */
export const MAX_KIT_SEEDS = 150;

/**
 * Stop adding medoids when the farthest remaining seed is this close (or closer)
 * to an existing medoid — it is not a distinct visual mode.
 */
export const KIT_MEDOID_MIN_SEPARATION = 10;

/**
 * Color-palette match bonus for kit nearness ranking.
 *
 * Palette Hamming within {@link KIT_COLOR_RADIUS} earns a score reduction
 * (closer ranks better), but only when structure Hamming is at most
 * {@link KIT_COLOR_STRUCTURE_GATE}. Beyond that gate color is ignored so
 * palette-similar unrelated photos cannot leapfrog real near-duplicates.
 * Brightness shifts that scramble bins still rank on dHash alone; crops that
 * keep a similar palette get a lift (Picsum harness; corpus GA deferred color).
 */
export const KIT_COLOR_RADIUS = 8;

/** Score reduction per palette-Hamming step under {@link KIT_COLOR_RADIUS}. */
export const KIT_COLOR_BONUS = 1.35;

/**
 * Max dHash Hamming at which the color bonus still applies. Higher values help
 * aggressive crops; lower values reject palette-only false positives.
 */
export const KIT_COLOR_STRUCTURE_GATE = 22;

/**
 * Softmax-style scale for kit–kit distinctiveness: weight = δ / (δ + τ).
 * Similar kits (small δ) barely compete; distant kits compete fully.
 * Tuned on corpus GA (excl AUC↑); τ rounded from best genome.
 */
export const KIT_RIVAL_TAU = 5;

/** Multiplier on the strongest rival steal penalty. */
export const KIT_RIVAL_LAMBDA = 4;

export type KitMedoid = {
    fileId: number;
    hashes: PackedDHash[];
    /** Packed color-palette hash when the phash entry has one. */
    color?: PackedDHash;
};

/**
 * Whether the file already has every tag in the kit.
 */
export const fileMatchesKitTags = (
    file: EnteFile,
    kitTags: readonly string[],
): boolean => {
    if (!kitTags.length) {
        return false;
    }
    const have = new Set(extractUserTags(file));
    return kitTags.every((tag) => have.has(tag));
};

/**
 * Library files that fully match the kit (stable id order).
 *
 * Videos and archived files are omitted — CLIP (and legacy dHash kit seeds)
 * must not use poster thumbnails or cold-storage photos as stand-ins.
 */
export const listKitSeedFiles = (
    libraryFiles: readonly EnteFile[],
    kitTags: readonly string[],
): EnteFile[] => {
    if (!kitTags.length) {
        return [];
    }
    return libraryFiles
        .filter(
            (file) =>
                !isEnteVideoFile(file) &&
                !isFileArchivedLocally(file) &&
                fileMatchesKitTags(file, kitTags),
        )
        .sort((a, b) => a.id - b.id);
};

const packedHashesFromEntry = (
    entry: PhashEntry | undefined,
): PackedDHash[] | undefined => {
    if (!entry?.hashes.length) {
        return undefined;
    }
    return entry.hashes.map((hex) => parseDHashHex(hex));
};

const packedColorFromEntry = (
    entry: PhashEntry | undefined,
): PackedDHash | undefined => {
    if (!entry?.color) {
        return undefined;
    }
    return parseDHashHex(entry.color);
};

/**
 * Nearness distance between two phash signals (lower = closer).
 *
 * Base signal is variant dHash Hamming. A close color palette applies a bonus
 * (score reduction) when structure is within the gate; a distant palette does
 * not add a penalty.
 */
export const blendedNearnessDistance = (
    leftHashes: PackedDHash[],
    leftColor: PackedDHash | undefined,
    rightHashes: PackedDHash[],
    rightColor: PackedDHash | undefined,
    colorBonus: number = KIT_COLOR_BONUS,
    colorRadius: number = KIT_COLOR_RADIUS,
    structureGate: number = KIT_COLOR_STRUCTURE_GATE,
): number => {
    const structure = variantHammingDistance(leftHashes, rightHashes);
    if (
        !leftColor ||
        !rightColor ||
        colorBonus <= 0 ||
        colorRadius <= 0 ||
        structure > structureGate
    ) {
        return structure;
    }
    const color = hammingDistancePacked(leftColor, rightColor);
    const match = Math.max(0, colorRadius - color);
    return Math.max(0, structure - colorBonus * match);
};

/** Structure-only distance — used for medoid diversity (modes = dHash clusters). */
const structureDistance = (left: KitMedoid, right: KitMedoid): number =>
    variantHammingDistance(left.hashes, right.hashes);

/** Ranking distance — dHash with optional color-match bonus. */
const rankDistance = (
    left: KitMedoid,
    right: KitMedoid,
    colorBonus: number = KIT_COLOR_BONUS,
    colorRadius: number = KIT_COLOR_RADIUS,
    structureGate: number = KIT_COLOR_STRUCTURE_GATE,
): number =>
    blendedNearnessDistance(
        left.hashes,
        left.color,
        right.hashes,
        right.color,
        colorBonus,
        colorRadius,
        structureGate,
    );

const medoidFromEntry = (
    fileId: number,
    entry: PhashEntry | undefined,
): KitMedoid | undefined => {
    const hashes = packedHashesFromEntry(entry);
    if (!hashes) {
        return undefined;
    }
    return {
        fileId,
        hashes,
        color: packedColorFromEntry(entry),
    };
};

/**
 * Pick a diverse subset of kit seeds as medoids (densest-first, then farthest-first).
 *
 * Starting from the densest seed (most neighbours within {@link minSeparation})
 * keeps the first mode representative; farthest-first then covers other visual
 * modes without clustering near-duplicates as separate medoids.
 *
 * @param seedFileIds fully tagged kit members (any order)
 * @param entries phash index
 */
export const pickKitMedoids = (
    seedFileIds: readonly number[],
    entries: ReadonlyMap<number, PhashEntry>,
    options?: {
        maxMedoids?: number;
        maxSeeds?: number;
        minSeparation?: number;
    },
): KitMedoid[] => {
    const maxMedoids = options?.maxMedoids ?? MAX_KIT_MEDOIDS;
    const maxSeeds = options?.maxSeeds ?? MAX_KIT_SEEDS;
    const minSeparation = options?.minSeparation ?? KIT_MEDOID_MIN_SEPARATION;

    const candidates: KitMedoid[] = [];
    const seen = new Set<number>();
    for (const fileId of [...seedFileIds].sort((a, b) => a - b)) {
        if (seen.has(fileId)) {
            continue;
        }
        seen.add(fileId);
        const medoid = medoidFromEntry(fileId, entries.get(fileId));
        if (!medoid) {
            continue;
        }
        candidates.push(medoid);
        if (candidates.length >= maxSeeds) {
            break;
        }
    }

    if (candidates.length === 0 || maxMedoids <= 0) {
        return [];
    }
    if (candidates.length === 1 || maxMedoids === 1) {
        return [candidates[0]!];
    }

    // Densest seed first: most other seeds within minSeparation (dHash only).
    let bestStart = 0;
    let bestDensity = -1;
    for (let i = 0; i < candidates.length; i++) {
        let density = 0;
        const pivot = candidates[i]!;
        for (let j = 0; j < candidates.length; j++) {
            if (i === j) {
                continue;
            }
            if (structureDistance(pivot, candidates[j]!) < minSeparation) {
                density++;
            }
        }
        if (
            density > bestDensity ||
            (density === bestDensity &&
                pivot.fileId < candidates[bestStart]!.fileId)
        ) {
            bestDensity = density;
            bestStart = i;
        }
    }

    const medoids: KitMedoid[] = [candidates[bestStart]!];
    const remaining = candidates.filter((_, index) => index !== bestStart);

    while (medoids.length < maxMedoids && remaining.length > 0) {
        let bestIndex = 0;
        let bestMinDistance = -1;
        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i]!;
            let minDistance = Number.POSITIVE_INFINITY;
            for (const medoid of medoids) {
                const distance = structureDistance(candidate, medoid);
                if (distance < minDistance) {
                    minDistance = distance;
                }
            }
            if (minDistance > bestMinDistance) {
                bestMinDistance = minDistance;
                bestIndex = i;
            }
        }
        if (bestMinDistance < minSeparation) {
            break;
        }
        medoids.push(remaining[bestIndex]!);
        remaining.splice(bestIndex, 1);
    }

    return medoids;
};

/**
 * Blended distance from a file to the nearest kit medoid. Missing hash → Infinity.
 */
export const kitNearnessDistance = (
    fileId: number,
    medoids: readonly KitMedoid[],
    entries: ReadonlyMap<number, PhashEntry>,
    colorBonus: number = KIT_COLOR_BONUS,
    colorRadius: number = KIT_COLOR_RADIUS,
    structureGate: number = KIT_COLOR_STRUCTURE_GATE,
): number => {
    if (!medoids.length) {
        return Number.POSITIVE_INFINITY;
    }
    const probe = medoidFromEntry(fileId, entries.get(fileId));
    if (!probe) {
        return Number.POSITIVE_INFINITY;
    }
    let best = Number.POSITIVE_INFINITY;
    for (const medoid of medoids) {
        const distance = rankDistance(
            probe,
            medoid,
            colorBonus,
            colorRadius,
            structureGate,
        );
        if (distance < best) {
            best = distance;
        }
        if (best === 0) {
            return 0;
        }
    }
    return best;
};

/**
 * Reorder gallery files by closeness to kit medoids (best / lowest distance first).
 *
 * When there are no medoids, returns a shallow copy unchanged.
 */
export const sortFilesByKitNearness = (
    files: EnteFile[],
    medoids: readonly KitMedoid[],
    entries: ReadonlyMap<number, PhashEntry>,
    colorBonus: number = KIT_COLOR_BONUS,
    colorRadius: number = KIT_COLOR_RADIUS,
    structureGate: number = KIT_COLOR_STRUCTURE_GATE,
): EnteFile[] => {
    if (!medoids.length) {
        return [...files];
    }
    return [...files].sort((a, b) => {
        const scoreA = kitNearnessDistance(
            a.id,
            medoids,
            entries,
            colorBonus,
            colorRadius,
            structureGate,
        );
        const scoreB = kitNearnessDistance(
            b.id,
            medoids,
            entries,
            colorBonus,
            colorRadius,
            structureGate,
        );
        if (scoreA !== scoreB) {
            return scoreA - scoreB;
        }
        return a.id - b.id;
    });
};

/**
 * Mean directed nearest-medoid distance (symmetric Hausdorff / 2).
 *
 * Small when any visual modes of the two kits overlap; large when they look
 * distinct. Empty side → Infinity.
 */
export const kitDistance = (
    left: readonly KitMedoid[],
    right: readonly KitMedoid[],
): number => {
    if (!left.length || !right.length) {
        return Number.POSITIVE_INFINITY;
    }
    const directedMean = (
        from: readonly KitMedoid[],
        to: readonly KitMedoid[],
    ): number => {
        let sum = 0;
        for (const a of from) {
            let best = Number.POSITIVE_INFINITY;
            for (const b of to) {
                const distance = rankDistance(a, b);
                if (distance < best) {
                    best = distance;
                }
            }
            sum += best;
        }
        return sum / from.length;
    };
    return (directedMean(left, right) + directedMean(right, left)) / 2;
};

/**
 * Distinctiveness of two kits in 0..1: δ / (δ + τ). Identical kits → 0.
 */
export const kitDistinctiveness = (
    kitDelta: number,
    tau: number = KIT_RIVAL_TAU,
): number => {
    if (!Number.isFinite(kitDelta) || kitDelta <= 0) {
        return 0;
    }
    if (tau <= 0) {
        return 1;
    }
    return kitDelta / (kitDelta + tau);
};

/**
 * Competitive nearness: selected-kit distance plus a soft steal penalty.
 *
 * For each rival R: steal = max(0, d_S − d_R), weighted by how distinct S and R
 * are. The strongest weighted steal is added (× λ). No rivals → plain distance.
 *
 * Pass {@link rivalWeights} (one per rival, from {@link kitDistinctiveness}) to
 * avoid recomputing kit–kit distance per file.
 */
export const kitNearnessDistanceCompetitive = (
    fileId: number,
    selected: readonly KitMedoid[],
    rivals: readonly (readonly KitMedoid[])[],
    entries: ReadonlyMap<number, PhashEntry>,
    options?: {
        lambda?: number;
        tau?: number;
        rivalWeights?: readonly number[];
        colorBonus?: number;
        colorRadius?: number;
        structureGate?: number;
    },
): number => {
    const lambda = options?.lambda ?? KIT_RIVAL_LAMBDA;
    const tau = options?.tau ?? KIT_RIVAL_TAU;
    const colorBonus = options?.colorBonus ?? KIT_COLOR_BONUS;
    const colorRadius = options?.colorRadius ?? KIT_COLOR_RADIUS;
    const structureGate = options?.structureGate ?? KIT_COLOR_STRUCTURE_GATE;

    const dSelected = kitNearnessDistance(
        fileId,
        selected,
        entries,
        colorBonus,
        colorRadius,
        structureGate,
    );
    if (!Number.isFinite(dSelected) || !rivals.length || lambda <= 0) {
        return dSelected;
    }

    let bestPenalty = 0;
    for (let i = 0; i < rivals.length; i++) {
        const rival = rivals[i]!;
        if (!rival.length) {
            continue;
        }
        const dRival = kitNearnessDistance(
            fileId,
            rival,
            entries,
            colorBonus,
            colorRadius,
            structureGate,
        );
        if (!Number.isFinite(dRival)) {
            continue;
        }
        const steal = Math.max(0, dSelected - dRival);
        if (steal === 0) {
            continue;
        }
        const weight =
            options?.rivalWeights?.[i] ??
            kitDistinctiveness(kitDistance(selected, rival), tau);
        const penalty = steal * weight;
        if (penalty > bestPenalty) {
            bestPenalty = penalty;
        }
    }
    return dSelected + lambda * bestPenalty;
};

export type KitBestFitShare = {
    presetId: string;
    /** Hashed library files for which this kit is the nearest. */
    winCount: number;
    /**
     * Fraction of scored (hashed) library files nearest this kit, 0..1.
     * Shares across kits with medoids sum to 1 when every scored file has a
     * finite distance to at least one kit.
     */
    share: number;
};

/**
 * Rank kits by how often each is the nearest kit for a hashed library file.
 *
 * Each file with a phash picks the kit with the lowest
 * {@link kitNearnessDistance} (ties → lower `presetId`). Kits with no medoids
 * get `share` 0. Denominator is the number of hashed files that could be scored
 * against at least one kit.
 */
export const rankKitsByBestFitShare = (
    kits: readonly { id: string; tags: readonly string[] }[],
    libraryFiles: readonly EnteFile[],
    entries: ReadonlyMap<number, PhashEntry>,
): KitBestFitShare[] => {
    if (!kits.length) {
        return [];
    }

    const medoidsByKit = new Map<string, KitMedoid[]>();
    for (const kit of kits) {
        const seeds = listKitSeedFiles(libraryFiles, kit.tags);
        medoidsByKit.set(
            kit.id,
            pickKitMedoids(
                seeds.map((file) => file.id),
                entries,
            ),
        );
    }

    const winCounts = new Map<string, number>();
    for (const kit of kits) {
        winCounts.set(kit.id, 0);
    }

    let scored = 0;
    for (const file of libraryFiles) {
        if (isEnteVideoFile(file) || !entries.has(file.id)) {
            continue;
        }
        let bestId: string | undefined;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const kit of kits) {
            const medoids = medoidsByKit.get(kit.id) ?? [];
            if (!medoids.length) {
                continue;
            }
            const distance = kitNearnessDistance(file.id, medoids, entries);
            if (!Number.isFinite(distance)) {
                continue;
            }
            if (
                bestId === undefined ||
                distance < bestDistance ||
                (distance === bestDistance && kit.id < bestId)
            ) {
                bestDistance = distance;
                bestId = kit.id;
            }
        }
        if (bestId === undefined) {
            continue;
        }
        scored++;
        winCounts.set(bestId, (winCounts.get(bestId) ?? 0) + 1);
    }

    const ranked: KitBestFitShare[] = kits.map((kit) => {
        const winCount = winCounts.get(kit.id) ?? 0;
        return {
            presetId: kit.id,
            winCount,
            share: scored > 0 ? winCount / scored : 0,
        };
    });
    ranked.sort((a, b) => {
        if (b.share !== a.share) {
            return b.share - a.share;
        }
        if (b.winCount !== a.winCount) {
            return b.winCount - a.winCount;
        }
        return a.presetId.localeCompare(b.presetId);
    });
    return ranked;
};

/**
 * Format a 0..1 share as a whole-number percent for kit labels.
 */
export const formatKitFitPercent = (share: number): string =>
    `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`;

/**
 * Reorder by competitive kit nearness (selected + soft rival penalty).
 *
 * When there are no selected medoids, returns a shallow copy unchanged.
 * When there are no rivals, matches {@link sortFilesByKitNearness}.
 */
export const sortFilesByKitNearnessCompetitive = (
    files: EnteFile[],
    selected: readonly KitMedoid[],
    rivals: readonly (readonly KitMedoid[])[],
    entries: ReadonlyMap<number, PhashEntry>,
    options?: {
        lambda?: number;
        tau?: number;
        colorBonus?: number;
        colorRadius?: number;
        structureGate?: number;
    },
): EnteFile[] => {
    if (!selected.length) {
        return [...files];
    }
    const tau = options?.tau ?? KIT_RIVAL_TAU;
    const rivalWeights = rivals.map((rival) =>
        rival.length ?
            kitDistinctiveness(kitDistance(selected, rival), tau) :
            0);
    const scoreOptions = { ...options, rivalWeights };
    return [...files].sort((a, b) => {
        const scoreA = kitNearnessDistanceCompetitive(
            a.id,
            selected,
            rivals,
            entries,
            scoreOptions,
        );
        const scoreB = kitNearnessDistanceCompetitive(
            b.id,
            selected,
            rivals,
            entries,
            scoreOptions,
        );
        if (scoreA !== scoreB) {
            return scoreA - scoreB;
        }
        return a.id - b.id;
    });
};

/**
 * Softmax-style scale for CLIP kit–kit distinctiveness (cosine distance 0..2).
 * Tuned loosely to corpus separations (~0.05–0.3 between kit centroids).
 */
export const KIT_EMBEDDING_RIVAL_TAU = 0.12;

/** Multiplier on the strongest rival steal penalty (CLIP path). */
export const KIT_EMBEDDING_RIVAL_LAMBDA = 4;

/**
 * Max CLIP visual modes per kit / tag-filter fit set.
 * 3 covers multi-mode kits without over-fragmenting on phones.
 */
export const MAX_KIT_EMBEDDING_MEDOIDS = 3;

/**
 * Cosine distance: stop adding a medoid when the farthest remaining seed is
 * this close (or closer) to an existing medoid — not a distinct mode.
 */
export const KIT_EMBEDDING_MEDOID_MIN_SEPARATION = 0.08;

const embeddingDot = (a: readonly number[], b: readonly number[]): number => {
    let sum = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        sum += a[i]! * b[i]!;
    }
    return sum;
};

/** Cosine distance between two L2-normalized vectors (0 = identical). */
export const embeddingCosineDistanceVectors = (
    left: readonly number[] | undefined,
    right: readonly number[] | undefined,
): number => {
    if (!left?.length || !right?.length || left.length !== right.length) {
        return Number.POSITIVE_INFINITY;
    }
    return 1 - embeddingDot(left, right);
};

export type KitEmbeddingMedoid = {
    fileId: number;
    vector: number[];
};

/**
 * Local density: how many other candidates sit within {@link minSeparation}.
 */
const kitEmbeddingLocalDensity = (
    pivot: KitEmbeddingMedoid,
    candidates: readonly KitEmbeddingMedoid[],
    minSeparation: number,
): number => {
    let density = 0;
    for (const other of candidates) {
        if (other.fileId === pivot.fileId) {
            continue;
        }
        if (
            embeddingCosineDistanceVectors(pivot.vector, other.vector) <
            minSeparation
        ) {
            density += 1;
        }
    }
    return density;
};

/**
 * Pick up to {@link MAX_KIT_EMBEDDING_MEDOIDS} real seed photos as CLIP medoids.
 *
 * Densest-first with min separation: finds multi-mode kits without promoting
 * singleton outliers (important for mistag ranking). Extra medoids need at
 * least one nearby seed (`density >= 1`).
 */
export const pickKitEmbeddingMedoids = (
    seedFileIds: readonly number[],
    embeddings: ReadonlyMap<number, number[]>,
    options?: {
        maxMedoids?: number;
        maxSeeds?: number;
        minSeparation?: number;
    },
): KitEmbeddingMedoid[] => {
    const maxMedoids = options?.maxMedoids ?? MAX_KIT_EMBEDDING_MEDOIDS;
    const maxSeeds = options?.maxSeeds ?? MAX_KIT_SEEDS;
    const minSeparation =
        options?.minSeparation ?? KIT_EMBEDDING_MEDOID_MIN_SEPARATION;

    const candidates: KitEmbeddingMedoid[] = [];
    const seen = new Set<number>();
    for (const fileId of [...seedFileIds].sort((a, b) => a - b)) {
        if (seen.has(fileId)) {
            continue;
        }
        seen.add(fileId);
        const vector = embeddings.get(fileId);
        if (vector?.length !== KIT_EMBEDDING_DIMS) {
            continue;
        }
        candidates.push({ fileId, vector });
        if (candidates.length >= maxSeeds) {
            break;
        }
    }

    if (candidates.length === 0 || maxMedoids <= 0) {
        return [];
    }
    if (candidates.length === 1 || maxMedoids === 1) {
        return [candidates[0]!];
    }

    const densityOf = (pivot: KitEmbeddingMedoid): number =>
        kitEmbeddingLocalDensity(pivot, candidates, minSeparation);

    let bestStart = 0;
    let bestDensity = -1;
    for (let i = 0; i < candidates.length; i++) {
        const pivot = candidates[i]!;
        const density = densityOf(pivot);
        if (
            density > bestDensity ||
            (density === bestDensity &&
                pivot.fileId < candidates[bestStart]!.fileId)
        ) {
            bestDensity = density;
            bestStart = i;
        }
    }

    const medoids: KitEmbeddingMedoid[] = [candidates[bestStart]!];
    const remaining = candidates.filter((_, index) => index !== bestStart);

    while (medoids.length < maxMedoids && remaining.length > 0) {
        let bestIndex = -1;
        let bestNextDensity = -1;
        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i]!;
            let minDistance = Number.POSITIVE_INFINITY;
            for (const medoid of medoids) {
                const distance = embeddingCosineDistanceVectors(
                    candidate.vector,
                    medoid.vector,
                );
                if (distance < minDistance) {
                    minDistance = distance;
                }
            }
            if (minDistance < minSeparation) {
                continue;
            }
            const density = densityOf(candidate);
            // Skip isolated points so mistags are not adopted as prototypes.
            if (density < 1) {
                continue;
            }
            if (
                density > bestNextDensity ||
                (density === bestNextDensity &&
                    (bestIndex < 0 ||
                        candidate.fileId < remaining[bestIndex]!.fileId))
            ) {
                bestNextDensity = density;
                bestIndex = i;
            }
        }
        if (bestIndex < 0) {
            break;
        }
        medoids.push(remaining[bestIndex]!);
        remaining.splice(bestIndex, 1);
    }

    return medoids;
};

/**
 * Mean L2-normalized embedding of seed file ids (kit centroid).
 * Kept for eval/export helpers; production ranking uses medoids.
 */
export const buildKitEmbeddingCentroid = (
    seedIds: readonly number[],
    embeddings: ReadonlyMap<number, number[]>,
    maxSeeds: number = MAX_KIT_SEEDS,
): number[] | undefined => {
    const acc = new Array(KIT_EMBEDDING_DIMS).fill(0) as number[];
    let count = 0;
    for (const id of seedIds) {
        if (count >= maxSeeds) {
            break;
        }
        const vector = embeddings.get(id);
        if (vector?.length !== KIT_EMBEDDING_DIMS) {
            continue;
        }
        for (let i = 0; i < KIT_EMBEDDING_DIMS; i++) {
            acc[i]! += vector[i]!;
        }
        count += 1;
    }
    if (count === 0) {
        return undefined;
    }
    let norm = 0;
    for (let i = 0; i < KIT_EMBEDDING_DIMS; i++) {
        norm += acc[i]! * acc[i]!;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < KIT_EMBEDDING_DIMS; i++) {
        acc[i]! /= norm;
    }
    return acc;
};

/**
 * Cosine distance to a single prototype vector (0 = identical).
 * Missing embedding → Infinity.
 */
export const kitEmbeddingDistance = (
    fileId: number,
    prototype: readonly number[] | undefined,
    embeddings: ReadonlyMap<number, number[]>,
): number => {
    if (!prototype?.length) {
        return Number.POSITIVE_INFINITY;
    }
    const vector = embeddings.get(fileId);
    if (vector?.length !== prototype.length) {
        return Number.POSITIVE_INFINITY;
    }
    return 1 - embeddingDot(vector, prototype);
};

/**
 * Min cosine distance to any medoid / prototype (multi-mode kits).
 */
export const kitEmbeddingMinDistance = (
    fileId: number,
    medoids: readonly (readonly number[])[],
    embeddings: ReadonlyMap<number, number[]>,
): number => {
    if (!medoids.length) {
        return Number.POSITIVE_INFINITY;
    }
    let best = Number.POSITIVE_INFINITY;
    for (const medoid of medoids) {
        const d = kitEmbeddingDistance(fileId, medoid, embeddings);
        if (d < best) {
            best = d;
        }
    }
    return best;
};

/**
 * Cosine distance between two prototypes (0 = identical).
 */
export const kitEmbeddingCentroidDistance = (
    left: readonly number[] | undefined,
    right: readonly number[] | undefined,
): number => embeddingCosineDistanceVectors(left, right);

/** Min distance between any pair across two medoid sets. */
const kitEmbeddingMedoidSetDistance = (
    left: readonly (readonly number[])[],
    right: readonly (readonly number[])[],
): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const a of left) {
        for (const b of right) {
            const d = embeddingCosineDistanceVectors(a, b);
            if (d < best) {
                best = d;
            }
        }
    }
    return best;
};

/**
 * Competitive CLIP nearness: min distance to selected medoids + soft steal
 * vs rival medoid sets.
 */
export const kitEmbeddingDistanceCompetitive = (
    fileId: number,
    selectedMedoids: readonly (readonly number[])[],
    rivalMedoidSets: readonly (readonly (readonly number[])[])[],
    embeddings: ReadonlyMap<number, number[]>,
    options?: {
        lambda?: number;
        tau?: number;
        rivalWeights?: readonly number[];
    },
): number => {
    const lambda = options?.lambda ?? KIT_EMBEDDING_RIVAL_LAMBDA;
    const tau = options?.tau ?? KIT_EMBEDDING_RIVAL_TAU;
    const dSelected = kitEmbeddingMinDistance(
        fileId,
        selectedMedoids,
        embeddings,
    );
    if (!Number.isFinite(dSelected) || !rivalMedoidSets.length || lambda <= 0) {
        return dSelected;
    }

    let bestPenalty = 0;
    for (let i = 0; i < rivalMedoidSets.length; i++) {
        const rival = rivalMedoidSets[i];
        if (!rival?.length) {
            continue;
        }
        const dRival = kitEmbeddingMinDistance(fileId, rival, embeddings);
        if (!Number.isFinite(dRival)) {
            continue;
        }
        const steal = Math.max(0, dSelected - dRival);
        if (steal === 0) {
            continue;
        }
        const weight =
            options?.rivalWeights?.[i] ??
            kitDistinctiveness(
                kitEmbeddingMedoidSetDistance(selectedMedoids, rival),
                tau,
            );
        const penalty = steal * weight;
        if (penalty > bestPenalty) {
            bestPenalty = penalty;
        }
    }
    return dSelected + lambda * bestPenalty;
};

/**
 * Reorder gallery by CLIP competitive nearness (lowest distance first).
 *
 * Videos are appended in original order after ranked stills — never scored by
 * poster-thumbnail embeddings.
 */
export const sortFilesByKitEmbeddingCompetitive = (
    files: EnteFile[],
    selectedMedoids: readonly (readonly number[])[],
    rivalMedoidSets: readonly (readonly (readonly number[])[])[],
    embeddings: ReadonlyMap<number, number[]>,
    options?: {
        lambda?: number;
        tau?: number;
    },
): EnteFile[] => {
    if (!selectedMedoids.length) {
        return [...files];
    }
    const stills: EnteFile[] = [];
    const videos: EnteFile[] = [];
    for (const file of files) {
        if (isEnteVideoFile(file)) {
            videos.push(file);
        } else {
            stills.push(file);
        }
    }
    const tau = options?.tau ?? KIT_EMBEDDING_RIVAL_TAU;
    const rivalWeights = rivalMedoidSets.map((rival) =>
        rival.length ?
            kitDistinctiveness(
                kitEmbeddingMedoidSetDistance(selectedMedoids, rival),
                tau,
            ) :
            0);
    const scoreOptions = { ...options, rivalWeights };
    stills.sort((a, b) => {
        const scoreA = kitEmbeddingDistanceCompetitive(
            a.id,
            selectedMedoids,
            rivalMedoidSets,
            embeddings,
            scoreOptions,
        );
        const scoreB = kitEmbeddingDistanceCompetitive(
            b.id,
            selectedMedoids,
            rivalMedoidSets,
            embeddings,
            scoreOptions,
        );
        if (scoreA !== scoreB) {
            return scoreA - scoreB;
        }
        return a.id - b.id;
    });
    return [...stills, ...videos];
};

/**
 * Rank kits by how often each is the nearest CLIP medoid-set for an embedded file.
 *
 * Medoids are built from kit members in `seedFiles` (typically the full library).
 * Claim shares are counted over embedded files in `scoreFiles` (typically the
 * currently shown gallery). Using the same list for both leaves all shares at 0%
 * when the visible set contains no tagged kit seeds.
 *
 * @param seedFiles files used to find kit prototypes; defaults to `scoreFiles`
 */
export const rankKitsByBestFitShareEmbedding = (
    kits: readonly { id: string; tags: readonly string[] }[],
    scoreFiles: readonly EnteFile[],
    embeddings: ReadonlyMap<number, number[]>,
    seedFiles: readonly EnteFile[] = scoreFiles,
): KitBestFitShare[] => {
    if (!kits.length) {
        return [];
    }

    const medoidsByKit = new Map<string, (readonly number[])[]>();
    for (const kit of kits) {
        const seeds = listKitSeedFiles(seedFiles, kit.tags);
        const medoids = pickKitEmbeddingMedoids(
            seeds.map((file) => file.id),
            embeddings,
        );
        medoidsByKit.set(
            kit.id,
            medoids.map((medoid) => medoid.vector),
        );
    }

    const winCounts = new Map<string, number>();
    for (const kit of kits) {
        winCounts.set(kit.id, 0);
    }

    let scored = 0;
    for (const file of scoreFiles) {
        if (isEnteVideoFile(file) || !embeddings.has(file.id)) {
            continue;
        }
        let bestId: string | undefined;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const kit of kits) {
            const medoids = medoidsByKit.get(kit.id) ?? [];
            if (!medoids.length) {
                continue;
            }
            const distance = kitEmbeddingMinDistance(
                file.id,
                medoids,
                embeddings,
            );
            if (!Number.isFinite(distance)) {
                continue;
            }
            if (
                bestId === undefined ||
                distance < bestDistance ||
                (distance === bestDistance && kit.id < bestId)
            ) {
                bestDistance = distance;
                bestId = kit.id;
            }
        }
        if (bestId === undefined) {
            continue;
        }
        scored += 1;
        winCounts.set(bestId, (winCounts.get(bestId) ?? 0) + 1);
    }

    const ranked: KitBestFitShare[] = kits.map((kit) => {
        const winCount = winCounts.get(kit.id) ?? 0;
        return {
            presetId: kit.id,
            winCount,
            share: scored > 0 ? winCount / scored : 0,
        };
    });
    ranked.sort((a, b) => {
        if (b.share !== a.share) {
            return b.share - a.share;
        }
        if (b.winCount !== a.winCount) {
            return b.winCount - a.winCount;
        }
        return a.presetId.localeCompare(b.presetId);
    });
    return ranked;
};
