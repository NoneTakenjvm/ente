/**
 * Worker-safe Stage-1 similar-photo clustering: dHash buckets → edges →
 * mutual nearest-neighbour → size-capped Kruskal. No DOM / EnteFile imports.
 *
 * [Note: progressive tight groups.] While comparing, near-exact edges
 * (distance ≤ {@link TIGHT_MATCH_DISTANCE}) are unioned immediately so the UI
 * can show real duplicate groups before the full mutual pass finishes. The
 * final result always re-runs mutual-kNN + Kruskal over every collected edge —
 * no pairs are skipped.
 */
import { hammingDistance } from "@/lib/phash";

/** Default cap when callers omit {@link maxGroupSize}. */
export const MAX_GROUP_SIZE = 5;
export const MUTUAL_RANK_K = 8;
export const TIGHT_MATCH_DISTANCE = 2;

export type Stage1Item = {
    fileId: number;
    hashes: string[];
};

export type Stage1Cluster = {
    fileIds: number[];
    furthestDistance: number;
};

export type Stage1ProgressUpdate = {
    phase: "comparing" | "finalizing" | "done";
    /** Images fully compared so far (comparing), or total when finalizing/done. */
    completed: number;
    total: number;
    /**
     * Present when provisional/final groups changed (or on finalize/done).
     * Omitted on compare ticks that only advance the counter — UI keeps prior groups.
     */
    clusters?: Stage1Cluster[];
};

type CandidateEdge = {
    left: number;
    right: number;
    distance: number;
};

class UnionFind {
    private readonly parent: number[];
    private readonly sizes: number[];

    constructor(size: number) {
        this.parent = Array.from({ length: size }, (_, index) => index);
        this.sizes = Array.from({ length: size }, () => 1);
    }

    find(index: number): number {
        if (this.parent[index] !== index) {
            this.parent[index] = this.find(this.parent[index]!);
        }
        return this.parent[index]!;
    }

    /**
     * @returns whether two different components were merged (false if already
     * united or the merge would exceed {@link maxSize}).
     */
    tryUnion(left: number, right: number, maxSize: number): boolean {
        const rootLeft = this.find(left);
        const rootRight = this.find(right);
        if (rootLeft === rootRight) {
            return false;
        }
        if (this.sizes[rootLeft]! + this.sizes[rootRight]! > maxSize) {
            return false;
        }
        if (this.sizes[rootLeft]! < this.sizes[rootRight]!) {
            this.parent[rootLeft] = rootRight;
            this.sizes[rootRight]! += this.sizes[rootLeft]!;
        } else {
            this.parent[rootRight] = rootLeft;
            this.sizes[rootLeft]! += this.sizes[rootRight]!;
        }
        return true;
    }
}

const hashBucketKey = (hash: string): string => hash.slice(0, 3);

const variantDistance = (left: string[], right: string[]): number => {
    let best = Number.MAX_SAFE_INTEGER;
    for (const leftHash of left) {
        for (const rightHash of right) {
            const distance = hammingDistance(leftHash, rightHash);
            if (distance < best) {
                best = distance;
            }
        }
    }
    return best;
};

const buildHashBuckets = (
    items: Stage1Item[],
): Map<string, number[]> => {
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < items.length; i++) {
        const seen = new Set<string>();
        for (const hash of items[i]!.hashes) {
            const key = hashBucketKey(hash);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const bucket = buckets.get(key);
            if (bucket) {
                bucket.push(i);
            } else {
                buckets.set(key, [i]);
            }
        }
    }
    return buckets;
};

const clustersFromUnionFind = (
    uf: UnionFind,
    items: Stage1Item[],
    edgeDistanceByPair: Map<string, number>,
    maxGroupSize: number,
): Stage1Cluster[] => {
    const membersByRoot = new Map<number, number[]>();
    for (let i = 0; i < items.length; i++) {
        const root = uf.find(i);
        const members = membersByRoot.get(root);
        if (members) {
            members.push(i);
        } else {
            membersByRoot.set(root, [i]);
        }
    }

    const clusters: Stage1Cluster[] = [];
    for (const memberIndices of membersByRoot.values()) {
        if (memberIndices.length < 2) {
            continue;
        }
        let furthest = 0;
        for (let i = 0; i < memberIndices.length; i++) {
            for (let j = i + 1; j < memberIndices.length; j++) {
                const a = Math.min(memberIndices[i]!, memberIndices[j]!);
                const b = Math.max(memberIndices[i]!, memberIndices[j]!);
                const distance = edgeDistanceByPair.get(`${a}:${b}`);
                if (distance !== undefined && distance > furthest) {
                    furthest = distance;
                }
            }
        }
        // Hard-slice oversized components (safety net; tryUnion should prevent most).
        for (let start = 0; start < memberIndices.length; start += maxGroupSize) {
            const slice = memberIndices.slice(start, start + maxGroupSize);
            if (slice.length < 2) {
                continue;
            }
            clusters.push({
                fileIds: slice.map((index) => items[index]!.fileId),
                furthestDistance: furthest,
            });
        }
    }
    return clusters.sort((a, b) => b.fileIds.length - a.fileIds.length);
};

const filterMutualNearestEdges = (
    edgeByKey: Map<string, CandidateEdge>,
): CandidateEdge[] => {
    const neighbors = new Map<number, Array<{ other: number; distance: number }>>();
    const pushNeighbor = (
        from: number,
        other: number,
        distance: number,
    ): void => {
        const list = neighbors.get(from);
        if (list) {
            list.push({ other, distance });
        } else {
            neighbors.set(from, [{ other, distance }]);
        }
    };

    for (const edge of edgeByKey.values()) {
        pushNeighbor(edge.left, edge.right, edge.distance);
        pushNeighbor(edge.right, edge.left, edge.distance);
    }

    const topKByIndex = new Map<number, Set<number>>();
    for (const [index, list] of neighbors.entries()) {
        list.sort((a, b) => a.distance - b.distance || a.other - b.other);
        topKByIndex.set(
            index,
            new Set(list.slice(0, MUTUAL_RANK_K).map((entry) => entry.other)),
        );
    }

    const mutual: CandidateEdge[] = [];
    for (const edge of edgeByKey.values()) {
        if (edge.distance <= TIGHT_MATCH_DISTANCE) {
            mutual.push(edge);
            continue;
        }
        const leftTop = topKByIndex.get(edge.left);
        const rightTop = topKByIndex.get(edge.right);
        if (!leftTop?.has(edge.right) || !rightTop?.has(edge.left)) {
            continue;
        }
        mutual.push(edge);
    }
    mutual.sort((a, b) => a.distance - b.distance);
    return mutual;
};

/** @returns true when a provisional tight-match merge occurred. */
const compareFileAgainstLaterBucketMates = (
    fileIndex: number,
    buckets: Map<string, number[]>,
    items: Stage1Item[],
    threshold: number,
    edgeByKey: Map<string, CandidateEdge>,
    provisionalUf: UnionFind,
    maxGroupSize: number,
): boolean => {
    const seenPartners = new Set<number>();
    let mergedTight = false;
    const consider = (otherIndex: number): void => {
        if (otherIndex <= fileIndex || seenPartners.has(otherIndex)) {
            return;
        }
        seenPartners.add(otherIndex);
        const left = fileIndex;
        const right = otherIndex;
        const key = `${left}:${right}`;
        if (edgeByKey.has(key)) {
            return;
        }
        const distance = variantDistance(
            items[left]!.hashes,
            items[right]!.hashes,
        );
        if (distance > threshold) {
            return;
        }
        edgeByKey.set(key, { left, right, distance });
        if (distance <= TIGHT_MATCH_DISTANCE) {
            if (provisionalUf.tryUnion(left, right, maxGroupSize)) {
                mergedTight = true;
            }
        }
    };

    for (const hash of items[fileIndex]!.hashes) {
        const key = hashBucketKey(hash);
        for (const other of buckets.get(key) ?? []) {
            consider(other);
        }
        const keyValue = Number.parseInt(key, 16);
        for (const delta of [-1, 1]) {
            const neighborKey = (keyValue + delta)
                .toString(16)
                .padStart(3, "0")
                .slice(-3);
            for (const other of buckets.get(neighborKey) ?? []) {
                consider(other);
            }
        }
    }
    return mergedTight;
};

/**
 * Sync Stage-1 for unit tests / small indexes. Same final algorithm as the
 * async path, without progress callbacks.
 */
export const runStage1ClusteringSync = (
    items: Stage1Item[],
    threshold: number,
    maxGroupSize: number = MAX_GROUP_SIZE,
): Stage1Cluster[] => {
    if (items.length < 2) {
        return [];
    }
    const buckets = buildHashBuckets(items);
    const edgeByKey = new Map<string, CandidateEdge>();
    const provisionalUf = new UnionFind(items.length);
    for (let i = 0; i < items.length; i++) {
        compareFileAgainstLaterBucketMates(
            i,
            buckets,
            items,
            threshold,
            edgeByKey,
            provisionalUf,
            maxGroupSize,
        );
    }
    const mutual = filterMutualNearestEdges(edgeByKey);
    const uf = new UnionFind(items.length);
    const edgeDistanceByPair = new Map<string, number>();
    for (const edge of mutual) {
        uf.tryUnion(edge.left, edge.right, maxGroupSize);
        edgeDistanceByPair.set(`${edge.left}:${edge.right}`, edge.distance);
    }
    return clustersFromUnionFind(uf, items, edgeDistanceByPair, maxGroupSize);
};

/**
 * Async Stage-1 with per-image progress. Yields to the event loop after each
 * image so worker `postMessage` progress actually reaches the UI thread.
 */
export const runStage1Clustering = async (
    items: Stage1Item[],
    threshold: number,
    onProgress: (update: Stage1ProgressUpdate) => void,
    shouldAbort?: () => boolean,
    maxGroupSize: number = MAX_GROUP_SIZE,
): Promise<Stage1Cluster[]> => {
    if (items.length < 2) {
        onProgress({
            phase: "done",
            completed: 0,
            total: 0,
            clusters: [],
        });
        return [];
    }

    const buckets = buildHashBuckets(items);
    const edgeByKey = new Map<string, CandidateEdge>();
    const provisionalUf = new UnionFind(items.length);
    const provisionalDistances = new Map<string, number>();
    const total = items.length;
    // Yield often enough for a live progress bar without drowning the main thread.
    const yieldEvery = Math.max(1, Math.min(24, Math.floor(total / 200) || 1));

    for (let i = 0; i < items.length; i++) {
        if (shouldAbort?.()) {
            throw new DOMException("Similarity grouping aborted", "AbortError");
        }
        const beforeSize = edgeByKey.size;
        const mergedTight = compareFileAgainstLaterBucketMates(
            i,
            buckets,
            items,
            threshold,
            edgeByKey,
            provisionalUf,
            maxGroupSize,
        );
        if (edgeByKey.size > beforeSize) {
            for (const [key, edge] of edgeByKey.entries()) {
                if (!provisionalDistances.has(key)) {
                    provisionalDistances.set(key, edge.distance);
                }
            }
        }

        const completed = i + 1;
        const shouldAttachClusters =
            mergedTight || completed === total || completed % yieldEvery === 0;
        onProgress({
            phase: "comparing",
            completed,
            total,
            clusters: shouldAttachClusters ?
                clustersFromUnionFind(
                    provisionalUf,
                    items,
                    provisionalDistances,
                    maxGroupSize,
                ) :
                undefined,
        });
        if (completed % yieldEvery === 0 || mergedTight || completed === total) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
        }
    }

    if (shouldAbort?.()) {
        throw new DOMException("Similarity grouping aborted", "AbortError");
    }

    onProgress({
        phase: "finalizing",
        completed: total,
        total,
        clusters: clustersFromUnionFind(
            provisionalUf,
            items,
            provisionalDistances,
            maxGroupSize,
        ),
    });
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

    const mutual = filterMutualNearestEdges(edgeByKey);
    const uf = new UnionFind(items.length);
    const edgeDistanceByPair = new Map<string, number>();
    for (const edge of mutual) {
        uf.tryUnion(edge.left, edge.right, maxGroupSize);
        edgeDistanceByPair.set(`${edge.left}:${edge.right}`, edge.distance);
    }
    const finalClusters = clustersFromUnionFind(
        uf,
        items,
        edgeDistanceByPair,
        maxGroupSize,
    );
    onProgress({
        phase: "done",
        completed: total,
        total,
        clusters: finalClusters,
    });
    return finalClusters;
};
