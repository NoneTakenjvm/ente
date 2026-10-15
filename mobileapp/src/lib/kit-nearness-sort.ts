/**
 * Gallery reorder by visual nearness to a tag kit.
 *
 * CLIP embeddings: seed photos are reduced to a few medoids (real photos), then
 * each gallery file is ranked by min cosine distance to those medoids (best /
 * lowest first). A soft exclusive-affinity penalty applies vs rival kit medoids.
 * Files without an embedding sort last.
 */
import { KIT_EMBEDDING_DIMS, type ReadonlyEmbeddingMap } from "@/lib/kit-embedding";
import { l2NormalizeEmbedding } from "@/lib/embedding-vector";
import { embeddingCosineDistance } from "@/lib/similarity-clip";
import { extractUserTags } from "@/lib/tags";
import { isEnteVideoFile } from "@/lib/media-kind";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import type { EnteFile } from "ente-media/file";

/** Cap seed sample size so medoid picking stays cheap on large kits. */
export const MAX_KIT_SEEDS = 150;

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
 * Videos and archived files are omitted — CLIP kit seeds must not use poster
 * thumbnails or cold-storage photos as stand-ins.
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

/**
 * Ids of {@link listKitSeedFiles}, read from the tag posting lists: walks the
 * kit's rarest tag and checks the others by set lookup, so the cost scales
 * with kit size rather than library size.
 *
 * @param seedFileById library files eligible as seeds, by id
 */
export const listKitSeedIds = (
    kitTags: readonly string[],
    fileIdsByTag: ReadonlyMap<string, ReadonlySet<number>>,
    seedFileById: ReadonlyMap<number, EnteFile>,
): number[] => {
    const postings = kitTags
        .map((tag) => fileIdsByTag.get(tag) ?? new Set<number>())
        .sort((a, b) => a.size - b.size);
    const [rarest, ...others] = postings;
    if (!rarest) {
        return [];
    }
    const ids: number[] = [];
    for (const id of rarest) {
        const file = seedFileById.get(id);
        if (
            file &&
            !isEnteVideoFile(file) &&
            !isFileArchivedLocally(file) &&
            others.every((posting) => posting.has(id))
        ) {
            ids.push(id);
        }
    }
    return ids.sort((a, b) => a - b);
};

/**
 * Sorted, de-duplicated seeds (up to {@link maxSeeds}) that {@link toCandidate}
 * can resolve.
 */
const collectSeedCandidates = <T>(
    seedFileIds: readonly number[],
    maxSeeds: number,
    toCandidate: (fileId: number) => T | undefined,
): T[] => {
    const candidates: T[] = [];
    const seen = new Set<number>();
    for (const fileId of [...seedFileIds].sort((a, b) => a - b)) {
        if (seen.has(fileId)) {
            continue;
        }
        seen.add(fileId);
        const candidate = toCandidate(fileId);
        if (!candidate) {
            continue;
        }
        candidates.push(candidate);
        if (candidates.length >= maxSeeds) {
            break;
        }
    }
    return candidates;
};

/** Order files by ascending score, ties by id. */
const sortByScore = (
    files: readonly EnteFile[],
    scoreById: ReadonlyMap<number, number>,
): EnteFile[] =>
    [...files].sort((a, b) => {
        const scoreA = scoreById.get(a.id)!;
        const scoreB = scoreById.get(b.id)!;
        if (scoreA !== scoreB) {
            return scoreA - scoreB;
        }
        return a.id - b.id;
    });

/**
 * Strongest weighted steal penalty across rivals: how much closer a rival is
 * than the selected kit, scaled by how distinct that rival is.
 */
const strongestRivalPenalty = <Rival extends { length: number }>(
    dSelected: number,
    rivals: readonly Rival[],
    distanceToRival: (rival: Rival) => number,
    weightFor: (rival: Rival, index: number) => number,
): number => {
    let bestPenalty = 0;
    for (let i = 0; i < rivals.length; i++) {
        const rival = rivals[i]!;
        if (!rival.length) {
            continue;
        }
        const dRival = distanceToRival(rival);
        if (!Number.isFinite(dRival)) {
            continue;
        }
        const steal = Math.max(0, dSelected - dRival);
        if (steal === 0) {
            continue;
        }
        const penalty = steal * weightFor(rival, i);
        if (penalty > bestPenalty) {
            bestPenalty = penalty;
        }
    }
    return bestPenalty;
};

/**
 * Distinctiveness of two kits in 0..1: δ / (δ + τ). Identical kits → 0.
 */
const kitDistinctiveness = (
    kitDelta: number,
    tau: number,
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
 * Softmax-style scale for CLIP kit–kit distinctiveness (cosine distance 0..2).
 * Smaller τ lets even similar rival kits compete. S2 research (savedAll
 * rivals): 0.02 beat 0.06 on hard AUC with no easy-AUC collapse.
 */
export const KIT_EMBEDDING_RIVAL_TAU = 0.02;

/**
 * Multiplier on the strongest rival steal penalty (CLIP path).
 * S2 pass 3b on production rivals: 16 is the plateau start; 24 is +0.3pp more.
 */
export const KIT_EMBEDDING_RIVAL_LAMBDA = 16;

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

type KitEmbeddingMedoid = {
    fileId: number;
    vector: Float32Array;
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
            embeddingCosineDistance(pivot.vector, other.vector) <
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
    embeddings: ReadonlyEmbeddingMap,
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

    const candidates = collectSeedCandidates<KitEmbeddingMedoid>(
        seedFileIds,
        maxSeeds,
        (fileId) => {
            const vector = embeddings.get(fileId);
            return vector?.length === KIT_EMBEDDING_DIMS ?
                { fileId, vector } :
                undefined;
        },
    );

    if (candidates.length === 0 || maxMedoids <= 0) {
        return [];
    }
    if (candidates.length === 1 || maxMedoids === 1) {
        return [candidates[0]!];
    }

    let bestStart = 0;
    let bestDensity = -1;
    for (let i = 0; i < candidates.length; i++) {
        const pivot = candidates[i]!;
        const density = kitEmbeddingLocalDensity(
            pivot,
            candidates,
            minSeparation,
        );
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
                const distance = embeddingCosineDistance(
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
            const density = kitEmbeddingLocalDensity(
                candidate,
                candidates,
                minSeparation,
            );
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

/** A vector blended into a kit centroid as if it were `weight` example photos. */
export interface KitEmbeddingPrior {
    vector: Float32Array;
    weight: number;
}

/**
 * Mean L2-normalized embedding of seed file ids (kit centroid).
 * Kept for eval/export helpers; production ranking uses medoids.
 * An optional `prior` joins the sum, so it also seeds a kit with no embedded
 * seeds.
 */
export const buildKitEmbeddingCentroid = (
    seedIds: readonly number[],
    embeddings: ReadonlyEmbeddingMap,
    maxSeeds: number = MAX_KIT_SEEDS,
    prior?: KitEmbeddingPrior,
): Float32Array | undefined => {
    const acc = new Float32Array(KIT_EMBEDDING_DIMS);
    if (prior) {
        for (let i = 0; i < KIT_EMBEDDING_DIMS; i++) {
            acc[i] = prior.weight * prior.vector[i]!;
        }
    }
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
    if (count === 0 && !prior) {
        return undefined;
    }
    return l2NormalizeEmbedding(acc);
};

/**
 * Min cosine distance to any medoid / prototype (multi-mode kits).
 * Missing embedding → Infinity.
 */
export const kitEmbeddingMinDistance = (
    fileId: number,
    medoids: readonly ArrayLike<number>[],
    embeddings: ReadonlyEmbeddingMap,
): number => {
    const vector = embeddings.get(fileId);
    let best = Number.POSITIVE_INFINITY;
    for (const medoid of medoids) {
        const distance = embeddingCosineDistance(vector, medoid);
        if (distance < best) {
            best = distance;
        }
    }
    return best;
};

/** Min distance between any pair across two medoid sets. */
const kitEmbeddingMedoidSetDistance = (
    left: readonly ArrayLike<number>[],
    right: readonly ArrayLike<number>[],
): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const a of left) {
        for (const b of right) {
            const d = embeddingCosineDistance(a, b);
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
    selectedMedoids: readonly ArrayLike<number>[],
    rivalMedoidSets: readonly (readonly ArrayLike<number>[])[],
    embeddings: ReadonlyEmbeddingMap,
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

    const bestPenalty = strongestRivalPenalty(
        dSelected,
        rivalMedoidSets,
        (rival) => kitEmbeddingMinDistance(fileId, rival, embeddings),
        (rival, index) =>
            options?.rivalWeights?.[index] ??
            kitDistinctiveness(
                kitEmbeddingMedoidSetDistance(selectedMedoids, rival),
                tau,
            ),
    );
    return dSelected + lambda * bestPenalty;
};

/**
 * Per-rival steal weights for {@link kitEmbeddingDistanceCompetitive}:
 * distinctiveness of each rival medoid set from the selected one. Computed
 * once per kit so every candidate scored against it reuses them; rivals
 * without medoids weigh 0.
 */
export const kitEmbeddingRivalWeights = (
    selectedMedoids: readonly ArrayLike<number>[],
    rivalMedoidSets: readonly (readonly ArrayLike<number>[])[],
    tau: number = KIT_EMBEDDING_RIVAL_TAU,
): number[] =>
    rivalMedoidSets.map((rival) =>
        rival.length ?
            kitDistinctiveness(
                kitEmbeddingMedoidSetDistance(selectedMedoids, rival),
                tau,
            ) :
            0);

/**
 * Reorder gallery by CLIP competitive nearness (lowest distance first).
 *
 * Videos are appended in original order after ranked stills — never scored by
 * poster-thumbnail embeddings. Each still is scored once; `distanceById`
 * returns those scores so callers can reuse them instead of rescoring.
 */
export const sortFilesByKitEmbeddingCompetitive = (
    files: EnteFile[],
    selectedMedoids: readonly ArrayLike<number>[],
    rivalMedoidSets: readonly (readonly ArrayLike<number>[])[],
    embeddings: ReadonlyEmbeddingMap,
    options?: {
        lambda?: number;
        tau?: number;
    },
): { files: EnteFile[]; distanceById: ReadonlyMap<number, number> } => {
    const distanceById = new Map<number, number>();
    if (!selectedMedoids.length) {
        return { files: [...files], distanceById };
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
    const rivalWeights = kitEmbeddingRivalWeights(
        selectedMedoids,
        rivalMedoidSets,
        options?.tau,
    );
    const scoreOptions = { ...options, rivalWeights };
    for (const file of stills) {
        distanceById.set(
            file.id,
            kitEmbeddingDistanceCompetitive(
                file.id,
                selectedMedoids,
                rivalMedoidSets,
                embeddings,
                scoreOptions,
            ),
        );
    }
    return {
        files: [...sortByScore(stills, distanceById), ...videos],
        distanceById,
    };
};
