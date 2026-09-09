/**
 * Greedy CLIP snake over a packed embedding matrix (no EnteFile / DOM).
 *
 * {@link ids}[i] is the file id for the 512-d (or {@link dim}) vector at
 * {@link packed}[i * dim]. Same nearest/farthest-neighbor walk as the gallery
 * relative sort; kept separate so the worker bundle stays small.
 */

export type RelativePackedMode = "closest" | "furthest";

/**
 * Walk a greedy nearest (or farthest) neighbor path through packed vectors.
 *
 * @param ids file ids aligned with {@link packed}
 * @param packed row-major embeddings, length `ids.length * dim`
 * @param dim embedding width (CLIP is 512)
 * @param mode closest vs furthest
 * @param seed picks the random start when {@link startFileId} is absent
 * @param startFileId when present and in {@link ids}, used as the chain tip
 */
export const sortIdsByRelativePacked = (
    ids: readonly number[],
    packed: Float32Array,
    dim: number,
    mode: RelativePackedMode,
    seed: number,
    startFileId?: number,
): number[] => {
    const count = ids.length;
    if (count < 2 || packed.length < count * dim) {
        return [...ids];
    }

    const startIndex = pickStartIndex(ids, seed, startFileId);
    const order = new Array<number>(count);
    order[0] = ids[startIndex]!;
    let written = 1;
    let currentIndex = startIndex;

    const rest: number[] = [];
    rest.length = count - 1;
    let restAt = 0;
    for (let index = 0; index < count; index += 1) {
        if (index !== startIndex) {
            rest[restAt] = index;
            restAt += 1;
        }
    }
    let restLength = count - 1;
    const preferClosest = mode === "closest";

    while (restLength > 0) {
        const base = currentIndex * dim;
        let bestK = 0;
        let bestIndex = rest[0]!;
        let bestId = ids[bestIndex]!;
        let bestDist = preferClosest ?
            Number.POSITIVE_INFINITY :
            Number.NEGATIVE_INFINITY;

        for (let k = 0; k < restLength; k += 1) {
            const index = rest[k]!;
            const off = index * dim;
            let dot = 0;
            for (let d = 0; d < dim; d += 1) {
                dot += packed[base + d]! * packed[off + d]!;
            }
            const dist = 1 - dot;
            const id = ids[index]!;
            const better = preferClosest ? dist < bestDist : dist > bestDist;
            if (better || (dist === bestDist && id < bestId)) {
                bestDist = dist;
                bestIndex = index;
                bestId = id;
                bestK = k;
            }
        }

        order[written] = bestId;
        written += 1;
        currentIndex = bestIndex;
        restLength -= 1;
        rest[bestK] = rest[restLength]!;
    }

    return order;
};

/**
 * Pick a deterministic start index from {@link ids} using mulberry32.
 */
export const pickRelativeStartIndex = (
    ids: readonly number[],
    seed: number,
): number => {
    if (ids.length === 0) {
        return 0;
    }
    let state = seed >>> 0;
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(u * ids.length);
};

const pickStartIndex = (
    ids: readonly number[],
    seed: number,
    startFileId: number | undefined,
): number => {
    if (startFileId !== undefined) {
        const explicit = ids.indexOf(startFileId);
        if (explicit >= 0) {
            return explicit;
        }
    }
    const sortedIds = [...ids].sort((a, b) => a - b);
    const startId = sortedIds[pickRelativeStartIndex(sortedIds, seed)]!;
    return ids.indexOf(startId);
};
