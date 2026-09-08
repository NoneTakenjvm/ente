/**
 * Gallery reorder by a greedy CLIP "snake": random start, then repeatedly
 * pick the closest (or furthest) remaining file to the current tip. Each
 * file appears once. Files without embeddings trail at the end.
 */
import type { EnteFile } from "ente-media/file";
import { KIT_EMBEDDING_DIMS } from "@/lib/kit-embedding";
import { embeddingCosineDistance } from "@/lib/similarity-clip";

/** Gallery reorder by relative CLIP nearest/farthest-neighbor chain. */
export type RelativeSort = "none" | "closest" | "furthest";

/**
 * Pick a deterministic start id from `ids` using a mulberry32 sample.
 *
 * @param ids non-empty candidate file ids
 * @param seed session seed from the UI store
 */
export const pickRelativeStartId = (
    ids: readonly number[],
    seed: number,
): number => {
    let state = seed >>> 0;
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return ids[Math.floor(u * ids.length)]!;
};

/**
 * Reorder filtered files as a greedy CLIP similarity path.
 *
 * @param files currently visible (already filtered) files
 * @param mode closest / furthest / none
 * @param embeddings CLIP index (Ente file id → L2-normalized vector)
 * @param seed picks the random first tip among embedded files
 */
export const sortFilesByRelative = (
    files: readonly EnteFile[],
    mode: RelativeSort,
    embeddings: ReadonlyMap<number, number[]>,
    seed: number,
): EnteFile[] => {
    if (mode === "none" || files.length < 2) {
        return [...files];
    }

    const withEmbedding: EnteFile[] = [];
    const withoutEmbedding: EnteFile[] = [];
    for (const file of files) {
        const vector = embeddings.get(file.id);
        if (vector?.length === KIT_EMBEDDING_DIMS) {
            withEmbedding.push(file);
        } else {
            withoutEmbedding.push(file);
        }
    }
    if (withEmbedding.length < 2) {
        return [...files];
    }

    const remaining = new Map(withEmbedding.map((file) => [file.id, file]));
    const candidateIds = [...remaining.keys()].sort((a, b) => a - b);
    const startId = pickRelativeStartId(candidateIds, seed);
    const order: EnteFile[] = [];
    let current = remaining.get(startId)!;
    remaining.delete(startId);
    order.push(current);

    const preferClosest = mode === "closest";
    while (remaining.size > 0) {
        const currentVector = embeddings.get(current.id);
        let bestId: number | undefined;
        let bestDist = preferClosest ?
            Number.POSITIVE_INFINITY :
            Number.NEGATIVE_INFINITY;
        for (const id of remaining.keys()) {
            const dist = embeddingCosineDistance(
                currentVector,
                embeddings.get(id),
            );
            if (!Number.isFinite(dist)) {
                continue;
            }
            const better = preferClosest ?
                dist < bestDist :
                dist > bestDist;
            const tie = dist === bestDist && bestId !== undefined && id < bestId;
            if (better || tie) {
                bestDist = dist;
                bestId = id;
            }
        }
        if (bestId === undefined) {
            break;
        }
        current = remaining.get(bestId)!;
        remaining.delete(bestId);
        order.push(current);
    }

    const leftovers = [...remaining.values()].sort((a, b) => a.id - b.id);
    return [...order, ...leftovers, ...withoutEmbedding];
};
