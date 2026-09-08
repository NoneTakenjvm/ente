/**
 * CLIP helpers for Similar Stage-1: gate weak dHash edges and rescue
 * near-misses that hashes alone miss. Worker-safe (no DOM).
 *
 * Cosine distance is {@code 1 - dot} on L2-normalized embeddings (0 = identical).
 */

/** Keep in sync with {@link TIGHT_MATCH_DISTANCE} in similarity-stage1-core. */
const TIGHT_MATCH_DISTANCE = 2;

/** Drop mid-band dHash edges farther than this cosine distance. */
export const SIMILAR_CLIP_GATE = 0.35;

/** Accept CLIP-close pairs even when Hamming is above the UI threshold. */
export const SIMILAR_CLIP_RESCUE = 0.12;

/** Max Hamming for a CLIP rescue edge (must be ≤ EDGE_COLLECT_THRESHOLD). */
export const SIMILAR_CLIP_RESCUE_HAM_MAX = 16;

export type SimilarClipKnobs = {
    gate: number;
    rescue: number;
    rescueHamMax: number;
};

export const DEFAULT_SIMILAR_CLIP_KNOBS: SimilarClipKnobs = {
    gate: SIMILAR_CLIP_GATE,
    rescue: SIMILAR_CLIP_RESCUE,
    rescueHamMax: SIMILAR_CLIP_RESCUE_HAM_MAX,
};

/**
 * Cosine distance between two L2-normalized vectors (0 = identical).
 * Mismatched / empty → Infinity.
 */
export const embeddingCosineDistance = (
    left: readonly number[] | undefined,
    right: readonly number[] | undefined,
): number => {
    if (!left?.length || !right?.length || left.length !== right.length) {
        return Number.POSITIVE_INFINITY;
    }
    let sum = 0;
    for (let i = 0; i < left.length; i++) {
        sum += left[i]! * right[i]!;
    }
    return 1 - sum;
};

/**
 * Whether a collected Stage-1 Hamming edge should participate in clustering
 * at {@link clusterThreshold}.
 *
 * Rules (near-dup hybrid):
 * - No CLIP → dHash-only (`hamming ≤ clusterThreshold`).
 * - Near-exact Hamming → always keep.
 * - Within threshold → keep only if CLIP ≤ gate (cuts false piles).
 * - Above threshold but ≤ rescueHamMax → keep if CLIP ≤ rescue (rescues misses).
 */
export const shouldKeepStage1Edge = (
    hamming: number,
    clipDistance: number | undefined,
    clusterThreshold: number,
    knobs: SimilarClipKnobs = DEFAULT_SIMILAR_CLIP_KNOBS,
): boolean => {
    if (clipDistance === undefined || !Number.isFinite(clipDistance)) {
        return hamming <= clusterThreshold;
    }
    if (hamming <= TIGHT_MATCH_DISTANCE) {
        return true;
    }
    if (
        hamming <= knobs.rescueHamMax &&
        clipDistance <= knobs.rescue
    ) {
        return true;
    }
    if (hamming <= clusterThreshold) {
        return clipDistance <= knobs.gate;
    }
    return false;
};
