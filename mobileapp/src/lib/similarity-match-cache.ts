import type { Stage1FileEdge } from "@/lib/similarity-stage1-core";

/**
 * Session cache for Similar-photo matching: Stage-1 edges (so threshold
 * changes recluster without recomparing hashes) and crop verdicts (so Stage-2
 * skips template-match for pairs already checked).
 */

type EdgeCacheEntry = {
    indexKey: string;
    /** Threshold used when collecting edges (edges.distance ≤ this). */
    collectThreshold: number;
    edges: Stage1FileEdge[];
};

let edgeCache: EdgeCacheEntry | undefined;
const cropVerdicts = new Map<string, boolean>();

const cropPairKey = (a: number, b: number): string =>
    a < b ? `${a}:${b}` : `${b}:${a}`;

/**
 * Stable key for the indexed Stage-1 item set (file id + primary hash).
 */
export const similarityIndexKey = (
    items: Array<{ fileId: number; hashes: string[] }>,
): string =>
    items
        .map((item) => `${item.fileId}:${item.hashes[0] ?? ""}`)
        .sort()
        .join("|");

export const getCachedStage1Edges = (
    indexKey: string,
    neededCollectThreshold: number,
): Stage1FileEdge[] | undefined => {
    if (
        edgeCache?.indexKey !== indexKey ||
        edgeCache.collectThreshold < neededCollectThreshold
    ) {
        return undefined;
    }
    return edgeCache.edges;
};

export const setCachedStage1Edges = (
    indexKey: string,
    collectThreshold: number,
    edges: Stage1FileEdge[],
): void => {
    edgeCache = { indexKey, collectThreshold, edges };
};

export const getCachedCropVerdict = (
    fileIdA: number,
    fileIdB: number,
): boolean | undefined => cropVerdicts.get(cropPairKey(fileIdA, fileIdB));

export const setCachedCropVerdict = (
    fileIdA: number,
    fileIdB: number,
    match: boolean,
): void => {
    cropVerdicts.set(cropPairKey(fileIdA, fileIdB), match);
};

export const clearSimilarityMatchCache = (): void => {
    edgeCache = undefined;
    cropVerdicts.clear();
};
