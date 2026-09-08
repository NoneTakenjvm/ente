/**
 * Gallery reorder by how well each photo fits the active tag filter visually.
 *
 * Picks a few CLIP medoids (real photos) from the filtered set, then sorts by
 * min cosine distance to those medoids (best = closest first, worst = farthest).
 * Missing vectors sort last for best / first for worst. Used to surface mistags.
 */
import type { EnteFile } from "ente-media/file";
import { KIT_EMBEDDING_DIMS } from "@/lib/kit-embedding";
import {
    kitEmbeddingMinDistance,
    pickKitEmbeddingMedoids,
} from "@/lib/kit-nearness-sort";

/** Gallery reorder by CLIP fit to the active tag-filter set. */
export type TagFilterFitSort = "none" | "best" | "worst";

/**
 * Reorder filtered files by min distance to CLIP medoids of that set.
 *
 * @param files currently visible (already tag-filtered) files
 * @param mode best / worst / none
 * @param embeddings CLIP index (Ente file id → L2-normalized vector)
 */
export const sortFilesByTagFilterFit = (
    files: readonly EnteFile[],
    mode: TagFilterFitSort,
    embeddings: ReadonlyMap<number, number[]>,
): EnteFile[] => {
    if (mode === "none" || files.length < 2) {
        return [...files];
    }
    const seedIds = files
        .map((file) => file.id)
        .filter((id) => {
            const vector = embeddings.get(id);
            return vector?.length === KIT_EMBEDDING_DIMS;
        });
    const medoids = pickKitEmbeddingMedoids(seedIds, embeddings);
    if (!medoids.length) {
        return [...files];
    }
    const prototypes = medoids.map((medoid) => medoid.vector);

    const bestFirst = mode === "best";
    return [...files].sort((a, b) => {
        const distA = kitEmbeddingMinDistance(a.id, prototypes, embeddings);
        const distB = kitEmbeddingMinDistance(b.id, prototypes, embeddings);
        const finiteA = Number.isFinite(distA);
        const finiteB = Number.isFinite(distB);
        if (finiteA !== finiteB) {
            // Missing embedding: last for best, first for worst (review queue).
            return finiteA === bestFirst ? -1 : 1;
        }
        if (finiteA && finiteB && distA !== distB) {
            return bestFirst ? distA - distB : distB - distA;
        }
        return a.id - b.id;
    });
};
