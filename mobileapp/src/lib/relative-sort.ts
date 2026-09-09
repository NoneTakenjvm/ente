/**
 * Gallery reorder by a greedy CLIP "snake": random start, then repeatedly
 * pick the closest (or furthest) remaining file to the current tip. Each
 * file appears once. Videos and files without embeddings trail at the end
 * (videos are never CLIP-judged by poster thumbnail).
 */
import type { EnteFile } from "ente-media/file";
import { KIT_EMBEDDING_DIMS } from "@/lib/kit-embedding";
import { isEnteVideoFile } from "@/lib/media-kind";
import {
    pickRelativeStartIndex,
    sortIdsByRelativePacked,
} from "@/lib/relative-sort-packed";

/** Gallery reorder by relative CLIP nearest/farthest-neighbor chain. */
export type RelativeSort = "none" | "closest" | "furthest";

export { pickRelativeStartIndex };

/**
 * Pick a deterministic start id from `ids` using a mulberry32 sample.
 *
 * @param ids non-empty candidate file ids
 * @param seed session seed from the UI store
 */
export const pickRelativeStartId = (
    ids: readonly number[],
    seed: number,
): number => ids[pickRelativeStartIndex(ids, seed)]!;

/**
 * Copy CLIP vectors for {@link fileIds} into a transferable Float32 buffer.
 *
 * @param fileIds ids in the same order the packed walk should use
 * @param embeddings CLIP index (Ente file id → L2-normalized vector)
 */
export const packRelativeEmbeddings = (
    fileIds: readonly number[],
    embeddings: ReadonlyMap<number, number[]>,
    dim: number = KIT_EMBEDDING_DIMS,
): Float32Array => {
    const packed = new Float32Array(fileIds.length * dim);
    for (let index = 0; index < fileIds.length; index += 1) {
        const vector = embeddings.get(fileIds[index]!);
        if (vector?.length !== dim) {
            continue;
        }
        packed.set(vector, index * dim);
    }
    return packed;
};

/**
 * Reorder filtered files as a greedy CLIP similarity path.
 *
 * @param files currently visible (already filtered) files
 * @param mode closest / furthest / none
 * @param embeddings CLIP index (Ente file id → L2-normalized vector)
 * @param seed picks the random first tip among embedded files
 * @param startFileId when present and embedded, used as the chain tip instead of seed
 */
export const sortFilesByRelative = (
    files: readonly EnteFile[],
    mode: RelativeSort,
    embeddings: ReadonlyMap<number, number[]>,
    seed: number,
    startFileId?: number,
): EnteFile[] => {
    if (mode === "none" || files.length < 2) {
        return [...files];
    }

    const withEmbedding: EnteFile[] = [];
    const skipped: EnteFile[] = [];
    for (const file of files) {
        const vector = embeddings.get(file.id);
        if (
            !isEnteVideoFile(file) &&
            vector?.length === KIT_EMBEDDING_DIMS
        ) {
            withEmbedding.push(file);
        } else {
            skipped.push(file);
        }
    }
    if (withEmbedding.length < 2) {
        return [...files];
    }

    const ids = withEmbedding.map((file) => file.id);
    const packed = packRelativeEmbeddings(ids, embeddings);
    const orderedIds = sortIdsByRelativePacked(
        ids,
        packed,
        KIT_EMBEDDING_DIMS,
        mode,
        seed,
        startFileId,
    );
    const byId = new Map(withEmbedding.map((file) => [file.id, file]));
    const order: EnteFile[] = [];
    for (const id of orderedIds) {
        const file = byId.get(id);
        if (file) {
            order.push(file);
        }
    }
    return [...order, ...skipped];
};
