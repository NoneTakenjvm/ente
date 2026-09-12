/**
 * Gallery reorder by how well each photo fits the active tag filter visually.
 *
 * Picks a few CLIP medoids (real photos) from the filtered set, then sorts by
 * min cosine distance to those medoids (best = closest first, worst = farthest).
 * Videos and missing vectors sort last for best / first for worst. Videos are
 * never used as medoids or scored (poster thumbnail ≠ content).
 */
import type { EnteFile } from "ente-media/file";
import { KIT_EMBEDDING_DIMS, type ReadonlyEmbeddingMap } from "@/lib/kit-embedding";
import { isEnteVideoFile } from "@/lib/media-kind";
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
    embeddings: ReadonlyEmbeddingMap,
): EnteFile[] => {
    if (mode === "none" || files.length < 2) {
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
    const seedIds = stills
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
    const scoreById = new Map<number, number>();
    for (const file of stills) {
        scoreById.set(
            file.id,
            kitEmbeddingMinDistance(file.id, prototypes, embeddings),
        );
    }
    stills.sort((a, b) => {
        const distA = scoreById.get(a.id) ?? Number.POSITIVE_INFINITY;
        const distB = scoreById.get(b.id) ?? Number.POSITIVE_INFINITY;
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
    // Videos never participate in CLIP ranking — trail after ranked stills.
    return [...stills, ...videos];
};
