/**
 * CLIP helpers for Similar: cosine distance, score mapping for the threshold
 * slider, and CLIP-first nearest-neighbour propose/confirm.
 *
 * Cosine distance is {@code 1 - dot} on L2-normalized embeddings (0 = identical).
 * Edge scores stored on {@link Stage1FileEdge} are {@code round(distance * 100)}
 * so the slider ({@link CLIP_SCORE_SLIDER_MIN}–{@link CLIP_SCORE_SLIDER_MAX})
 * means CLIP ≤ 0.08–0.16.
 *
 * Worker-safe (no DOM).
 */

/** Slider floor — stricter than this is rarely useful for near-dupes. */
export const CLIP_SCORE_SLIDER_MIN = 8;

/** Slider ceiling / collect max — looser pulls in “same scene” false piles. */
export const CLIP_SCORE_SLIDER_MAX = 16;

/** Collect CLIP edges up to this score. Must match {@link CLIP_SCORE_SLIDER_MAX}. */
export const CLIP_SCORE_COLLECT_MAX = CLIP_SCORE_SLIDER_MAX;

/**
 * Edges at or below this score skip the mutual-neighbour confirm
 * (near-identical embeddings). Below the slider floor so they always survive
 * once collected.
 */
export const CLIP_TIGHT_SCORE = 5;

/** Mutual confirm: each side must list the other in its top-K within collect. */
export const CLIP_CONFIRM_TOP_K = 3;

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

/** Map CLIP cosine distance to the Similar slider score (integer 0–100). */
export const clipDistanceToScore = (distance: number): number =>
    Math.max(0, Math.round(distance * 100));

/** Slider score back to cosine distance (for labels / docs). */
export const clipScoreToDistance = (score: number): number => score / 100;

/** Clamp a threshold into the Similar CLIP slider range. */
export const clampClipScoreThreshold = (score: number): number =>
    Math.min(
        CLIP_SCORE_SLIDER_MAX,
        Math.max(CLIP_SCORE_SLIDER_MIN, Math.round(score)),
    );

export type ClipNeighbour = {
    /** Index into the embedded-item list (not file id). */
    other: number;
    score: number;
};

/**
 * Insert {@link candidate} into a sorted ascending top-K list (by score, then
 * other id). Keeps at most {@link topK} entries.
 */
const insertTopNeighbour = (
    list: ClipNeighbour[],
    candidate: ClipNeighbour,
    topK: number,
): void => {
    let insertAt = list.length;
    for (let i = 0; i < list.length; i++) {
        const cur = list[i]!;
        if (
            candidate.score < cur.score ||
            (candidate.score === cur.score && candidate.other < cur.other)
        ) {
            insertAt = i;
            break;
        }
    }
    if (insertAt >= topK) {
        return;
    }
    list.splice(insertAt, 0, candidate);
    if (list.length > topK) {
        list.length = topK;
    }
};

/**
 * For each embedded vector, find up to {@link CLIP_CONFIRM_TOP_K} nearest
 * others with score ≤ {@link CLIP_SCORE_COLLECT_MAX}.
 */
export const findClipTopNeighbours = (
    vectors: readonly (readonly number[])[],
    topK: number = CLIP_CONFIRM_TOP_K,
    collectMax: number = CLIP_SCORE_COLLECT_MAX,
): ClipNeighbour[][] => {
    const n = vectors.length;
    const result: ClipNeighbour[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
        const left = vectors[i]!;
        const neighbours: ClipNeighbour[] = [];
        for (let j = 0; j < n; j++) {
            if (i === j) {
                continue;
            }
            const dist = embeddingCosineDistance(left, vectors[j]);
            if (!Number.isFinite(dist)) {
                continue;
            }
            const score = clipDistanceToScore(dist);
            if (score > collectMax) {
                continue;
            }
            insertTopNeighbour(neighbours, { other: j, score }, topK);
        }
        result[i] = neighbours;
    }
    return result;
};

/**
 * Fill one row of top-K neighbours (async Stage-1 progress loop).
 */
export const findClipTopNeighboursForIndex = (
    vectors: readonly (readonly number[])[],
    index: number,
    topK: number = CLIP_CONFIRM_TOP_K,
    collectMax: number = CLIP_SCORE_COLLECT_MAX,
): ClipNeighbour[] => {
    const left = vectors[index]!;
    const neighbours: ClipNeighbour[] = [];
    for (let j = 0; j < vectors.length; j++) {
        if (j === index) {
            continue;
        }
        const dist = embeddingCosineDistance(left, vectors[j]);
        if (!Number.isFinite(dist)) {
            continue;
        }
        const score = clipDistanceToScore(dist);
        if (score > collectMax) {
            continue;
        }
        insertTopNeighbour(neighbours, { other: j, score }, topK);
    }
    return neighbours;
};

/**
 * Confirm a proposed CLIP edge beyond 1-NN: tight scores always pass;
 * otherwise both sides must list each other in their top-K.
 */
export const shouldConfirmClipEdge = (
    leftTop: readonly ClipNeighbour[],
    rightTop: readonly ClipNeighbour[],
    leftIndex: number,
    rightIndex: number,
    score: number,
    tightScore: number = CLIP_TIGHT_SCORE,
): boolean => {
    if (score <= tightScore) {
        return true;
    }
    const leftHasRight = leftTop.some((n) => n.other === rightIndex);
    const rightHasLeft = rightTop.some((n) => n.other === leftIndex);
    return leftHasRight && rightHasLeft;
};

const upsertEdge = (
    edgeByKey: Map<string, number>,
    left: number,
    right: number,
    score: number,
): void => {
    const a = Math.min(left, right);
    const b = Math.max(left, right);
    const key = `${a}:${b}`;
    const prev = edgeByKey.get(key);
    if (prev === undefined || score < prev) {
        edgeByKey.set(key, score);
    }
};

/**
 * Build confirmed undirected CLIP edges from per-item top neighbours.
 *
 * Propose:
 * - each file’s closest neighbour (1-NN) within the collect band
 * - mutual top-K edges (links multi-copy piles beyond a single snake edge)
 *
 * Final “are they close enough?” is the UI threshold on these scores.
 */
export const collectConfirmedClipEdges = (
    topByIndex: readonly (readonly ClipNeighbour[])[],
): Array<{ left: number; right: number; score: number }> => {
    const edgeByKey = new Map<string, number>();

    for (let i = 0; i < topByIndex.length; i++) {
        const nn = topByIndex[i]![0];
        if (nn) {
            upsertEdge(edgeByKey, i, nn.other, nn.score);
        }
    }

    for (let i = 0; i < topByIndex.length; i++) {
        const leftTop = topByIndex[i]!;
        for (const neighbour of leftTop) {
            const j = neighbour.other;
            if (j <= i) {
                continue;
            }
            const rightTop = topByIndex[j]!;
            if (
                !shouldConfirmClipEdge(
                    leftTop,
                    rightTop,
                    i,
                    j,
                    neighbour.score,
                )
            ) {
                continue;
            }
            upsertEdge(edgeByKey, i, j, neighbour.score);
        }
    }

    const edges: Array<{ left: number; right: number; score: number }> = [];
    for (const [key, score] of edgeByKey.entries()) {
        const [left, right] = key.split(":").map(Number) as [number, number];
        edges.push({ left, right, score });
    }
    edges.sort((a, b) => a.score - b.score);
    return edges;
};
