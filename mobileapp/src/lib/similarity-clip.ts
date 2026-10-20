/**
 * CLIP helpers for Similar: cosine distance, score mapping for the threshold
 * slider, all-pairs collection and one-to-one pairing.
 *
 * Cosine distance is {@code 1 - dot} on L2-normalized embeddings (0 = identical).
 * Pair scores are {@code round(distance * 100)}, so the slider
 * ({@link CLIP_SCORE_SLIDER_MIN}–{@link CLIP_SCORE_SLIDER_MAX}) means
 * CLIP ≤ 0.02–0.25.
 *
 * Worker-safe (no DOM).
 */

/** Every collected pair as parallel arrays (row i is one pair). */
export type ClipPairs = {
    leftIds: Float64Array;
    rightIds: Float64Array;
    scores: Uint8Array;
};

/** Slider floor — near-identical copies only. */
export const CLIP_SCORE_SLIDER_MIN = 2;

/** Slider ceiling; pairs are collected up to this so the slider never rescans. */
export const CLIP_SCORE_SLIDER_MAX = 25;

/**
 * Cosine distance between two L2-normalized vectors (0 = identical).
 * Mismatched / empty → Infinity.
 */
export const embeddingCosineDistance = (
    left: ArrayLike<number> | undefined,
    right: ArrayLike<number> | undefined,
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

/** Clamp a threshold into the Similar CLIP slider range. */
export const clampClipScoreThreshold = (score: number): number =>
    Math.min(
        CLIP_SCORE_SLIDER_MAX,
        Math.max(CLIP_SCORE_SLIDER_MIN, Math.round(score)),
    );

/**
 * Compare every pair of packed vectors and keep those scoring at most
 * {@link maxScore}. O(n²) dot products — run it in a worker.
 *
 * @param fileIds row i of {@link packed} belongs to `fileIds[i]`
 * @param onRow called after each row with the number of rows done
 * @param queryCount only the first `queryCount` rows are searched, each
 * against every later row, so every pair has at least one query file and no
 * pair repeats. Defaults to all rows.
 */
export const collectClipPairs = (
    fileIds: ArrayLike<number>,
    packed: Float32Array,
    dims: number,
    maxScore: number = CLIP_SCORE_SLIDER_MAX,
    onRow?: (completed: number) => void,
    queryCount: number = fileIds.length,
): ClipPairs => {
    const leftIds: number[] = [];
    const rightIds: number[] = [];
    const scores: number[] = [];
    // Reject on the raw dot first; a point of slack leaves rounding at the
    // band edge to the exact score check below.
    const minDot = 1 - (maxScore + 1) / 100;
    for (let row = 0; row < queryCount; row++) {
        const rowStart = row * dims;
        for (let other = row + 1; other < fileIds.length; other++) {
            const otherStart = other * dims;
            let dot = 0;
            for (let d = 0; d < dims; d++) {
                dot += packed[rowStart + d]! * packed[otherStart + d]!;
            }
            if (dot < minDot) {
                continue;
            }
            const score = clipDistanceToScore(1 - dot);
            if (score > maxScore) {
                continue;
            }
            leftIds.push(fileIds[row]!);
            rightIds.push(fileIds[other]!);
            scores.push(score);
        }
        onRow?.(row + 1);
    }
    return {
        leftIds: Float64Array.from(leftIds),
        rightIds: Float64Array.from(rightIds),
        scores: Uint8Array.from(scores),
    };
};

/**
 * Pair up files whose CLIP score is at most {@link threshold}.
 *
 * [Note: One-to-one Similar pairs]
 *
 * Pairs are taken tightest first and each file joins at most one, so every
 * result is a file and its closest match that is still unpaired. Results are
 * never larger than two, so one duplicate can't pull unrelated photos in.
 *
 * @param isLive drops files no longer eligible since the pairs were collected
 * @returns `[leftId, rightId]` pairs, tightest first
 */
export const groupClipPairs = (
    pairs: ClipPairs,
    threshold: number,
    isLive: (fileId: number) => boolean,
): number[][] => {
    const kept: number[] = [];
    for (let i = 0; i < pairs.scores.length; i++) {
        if (
            pairs.scores[i]! <= threshold &&
            isLive(pairs.leftIds[i]!) &&
            isLive(pairs.rightIds[i]!)
        ) {
            kept.push(i);
        }
    }
    kept.sort((a, b) => pairs.scores[a]! - pairs.scores[b]! || a - b);

    const pairedIds = new Set<number>();
    const groups: number[][] = [];
    for (const i of kept) {
        const leftId = pairs.leftIds[i]!;
        const rightId = pairs.rightIds[i]!;
        if (pairedIds.has(leftId) || pairedIds.has(rightId)) {
            continue;
        }
        pairedIds.add(leftId);
        pairedIds.add(rightId);
        groups.push([leftId, rightId]);
    }
    return groups;
};
