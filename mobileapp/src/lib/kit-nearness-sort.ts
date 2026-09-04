/**
 * Gallery reorder by visual nearness to a tag kit.
 *
 * Seeds are library files that already carry every kit tag. Their dHashes are
 * summarized as a small set of medoids (visual modes), then each gallery file
 * is scored by variant dHash Hamming with a color-palette match bonus — best
 * first. When rival kits are provided, a soft exclusive-affinity penalty pushes
 * down files that fit another kit better (attenuated when the kits themselves
 * look alike).
 *
 * This is near-duplicate affinity, not thematic "kit vibe". Files without a
 * phash entry sort last.
 */
import type { PhashEntry } from "@/lib/crop-match";
import {
    hammingDistancePacked,
    parseDHashHex,
    variantHammingDistance,
    type PackedDHash,
} from "@/lib/phash";
import { extractUserTags } from "@/lib/tags";
import type { EnteFile } from "ente-media/file";

/** Cap how many visual modes we keep per kit. */
export const MAX_KIT_MEDOIDS = 6;

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
 * keep a similar palette get a lift (tuned on the Picsum kit-nearness harness).
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
 * Tuned on the multi-kit competitive harness (excl AUC↑, soft-tie lift≈0).
 */
export const KIT_RIVAL_TAU = 4;

/** Multiplier on the strongest rival steal penalty. */
export const KIT_RIVAL_LAMBDA = 2;

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
 */
export const listKitSeedFiles = (
    libraryFiles: readonly EnteFile[],
    kitTags: readonly string[],
): EnteFile[] => {
    if (!kitTags.length) {
        return [];
    }
    return libraryFiles
        .filter((file) => fileMatchesKitTags(file, kitTags))
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
            0,
    );
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
