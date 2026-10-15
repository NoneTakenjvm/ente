/**
 * Greedy CLIP snake over a packed embedding matrix (no EnteFile / DOM).
 *
 * {@link ids}[i] is the file id for the 512-d (or {@link dim}) vector at
 * {@link packed}[i * dim]. Same nearest/farthest-neighbor walk as the gallery
 * relative sort; kept separate so the worker bundle stays small.
 */
import { createRng } from "@/lib/shuffle-files";

export type RelativePackedMode = "closest" | "furthest";

/** Chain length of the first {@link sortIdsByRelativePacked} prefix report; doubles after each. */
const FIRST_PREFIX_REPORT = 200;

/**
 * Walk a greedy nearest (or farthest) neighbor path through packed vectors.
 *
 * The walk is O(n² · dim), so large libraries take seconds to minutes;
 * {@link onPrefix} lets the gallery show the head of the chain meanwhile.
 *
 * @param ids file ids aligned with {@link packed}
 * @param packed row-major embeddings, length `ids.length * dim`; rows are
 * reordered in place, so the caller must not reuse it
 * @param dim embedding width (CLIP is 512)
 * @param mode closest vs furthest
 * @param seed picks the random start when {@link startFileId} is absent
 * @param startFileId when present and in {@link ids}, the first file and the
 * fixed reference every other file is ranked against (no chaining)
 * @param onPrefix called with the chain so far at 200, 400, 800… files
 */
export const sortIdsByRelativePacked = (
    ids: readonly number[],
    packed: Float32Array,
    dim: number,
    mode: RelativePackedMode,
    seed: number,
    startFileId?: number,
    onPrefix?: (orderSoFar: readonly number[]) => void,
): number[] => {
    const count = ids.length;
    if (count < 2 || packed.length < count * dim) {
        return [...ids];
    }

    const preferClosest = mode === "closest";
    // An explicit start file ("Set Relative") ranks everything against itself
    // instead of chaining from the previous pick: one O(n · dim) scoring pass
    // and a sort, not the O(n²) walk.
    if (startFileId !== undefined) {
        const startRow = ids.indexOf(startFileId);
        if (startRow >= 0) {
            return rankAgainstRow(ids, packed, dim, preferClosest, startRow);
        }
    }

    // Remaining rows stay packed in [0, remaining): taking a row moves the
    // last remaining row into its slot, so each scan reads memory in order.
    const rowIds = [...ids];
    const tip = new Float32Array(dim);
    const order: number[] = [];
    let remaining = count;
    let nextRow = pickStartIndex(ids, seed);
    let nextPrefixReport = FIRST_PREFIX_REPORT;

    while (remaining > 0) {
        order.push(rowIds[nextRow]!);
        tip.set(packed.subarray(nextRow * dim, nextRow * dim + dim));
        remaining -= 1;
        rowIds[nextRow] = rowIds[remaining]!;
        packed.copyWithin(nextRow * dim, remaining * dim, remaining * dim + dim);
        if (onPrefix && order.length === nextPrefixReport && remaining > 0) {
            onPrefix(order);
            nextPrefixReport *= 2;
        }

        let bestId = Number.POSITIVE_INFINITY;
        let bestDist = preferClosest ?
            Number.POSITIVE_INFINITY :
            Number.NEGATIVE_INFINITY;
        for (let row = 0, offset = 0; row < remaining; row += 1, offset += dim) {
            let dot = 0;
            for (let d = 0; d < dim; d += 1) {
                dot += tip[d]! * packed[offset + d]!;
            }
            const dist = 1 - dot;
            const id = rowIds[row]!;
            const better = preferClosest ? dist < bestDist : dist > bestDist;
            if (better || (dist === bestDist && id < bestId)) {
                bestDist = dist;
                bestId = id;
                nextRow = row;
            }
        }
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
    return Math.floor(createRng(seed)() * ids.length);
};

/**
 * The start row first, then every other row ordered by distance to it
 * (ties broken by id).
 */
const rankAgainstRow = (
    ids: readonly number[],
    packed: Float32Array,
    dim: number,
    preferClosest: boolean,
    startRow: number,
): number[] => {
    const reference = packed.subarray(startRow * dim, startRow * dim + dim);
    const rows: { id: number; dist: number }[] = [];
    for (let row = 0, offset = 0; row < ids.length; row += 1, offset += dim) {
        if (row === startRow) {
            continue;
        }
        let dot = 0;
        for (let d = 0; d < dim; d += 1) {
            dot += reference[d]! * packed[offset + d]!;
        }
        rows.push({ id: ids[row]!, dist: 1 - dot });
    }
    rows.sort((a, b) => {
        if (a.dist === b.dist) {
            return a.id - b.id;
        }
        return preferClosest ? a.dist - b.dist : b.dist - a.dist;
    });
    return [ids[startRow]!, ...rows.map((row) => row.id)];
};

const pickStartIndex = (ids: readonly number[], seed: number): number => {
    const sortedIds = [...ids].sort((a, b) => a - b);
    const startId = sortedIds[pickRelativeStartIndex(sortedIds, seed)]!;
    return ids.indexOf(startId);
};
