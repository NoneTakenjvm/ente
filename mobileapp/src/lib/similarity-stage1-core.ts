/**
 * Worker-safe Stage-1 similar-photo clustering.
 *
 * When CLIP embeddings are provided: nearest-neighbour propose (top-K within
 * collect band) → mutual/tight confirm → union-find. Edge `distance` is
 * {@code round(clipCosine * 100)} so the UI slider (8–16) maps to CLIP 0.08–0.16.
 *
 * Without embeddings: dHash buckets → Hamming edges → mutual-kNN → Kruskal.
 *
 * [Note: progressive tight groups.] dHash path unions near-exact edges
 * (distance ≤ {@link TIGHT_MATCH_DISTANCE}) immediately for provisional UI.
 *
 * [Note: packed hashes.] Hex strings are parsed once into {@link PackedDHash}
 * limbs before the compare loop — Hamming uses uint32 XOR + SWAR popcount.
 *
 * [Note: group size cap.] Clustering itself is uncapped. Callers trim oversized
 * components for display after grouping; capping during union artificially
 * fragments the graph into many small groups.
 */
import {
    CLIP_CONFIRM_TOP_K,
    CLIP_SCORE_COLLECT_MAX,
    collectConfirmedClipEdges,
    findClipTopNeighbours,
    findClipTopNeighboursForIndex,
} from "@/lib/similarity-clip";
import {
    parseDHashHex,
    variantHammingDistance,
    type PackedDHash,
} from "@/lib/phash";

/** Default display trim when callers omit a max (not used during clustering). */
export const MAX_GROUP_SIZE = 5;
export const MUTUAL_RANK_K = 8;
export const TIGHT_MATCH_DISTANCE = 2;

export {
    CLIP_SCORE_COLLECT_MAX,
    CLIP_SCORE_SLIDER_MAX,
    CLIP_SCORE_SLIDER_MIN,
    clampClipScoreThreshold,
} from "@/lib/similarity-clip";

/** Soft throttle for provisional cluster snapshots during compare (ms). */
const CLUSTER_PROGRESS_INTERVAL_MS = 300;

export type Stage1Item = {
    fileId: number;
    hashes: string[];
};

export type Stage1Cluster = {
    fileIds: number[];
    furthestDistance: number;
};

/** Pairwise Stage-1 edge keyed by file id (safe to cache across threshold changes). */
export type Stage1FileEdge = {
    leftFileId: number;
    rightFileId: number;
    distance: number;
};

/** Optional CLIP vectors keyed by Ente file id (L2-normalized). */
export type Stage1EmbeddingMap = ReadonlyMap<number, ArrayLike<number>>;

export type Stage1ClipOptions = {
    embeddings: Stage1EmbeddingMap;
};

export type Stage1ClusteringResult = {
    clusters: Stage1Cluster[];
    /** All edges collected at {@link collectThreshold} (for threshold re-clustering). */
    edges: Stage1FileEdge[];
};

/**
 * Collect Hamming edges up to this distance so later threshold changes within
 * the Similar slider range can recluster without recomparing hashes.
 * Must stay ≥ the UI slider max in manage.tsx.
 */
export const EDGE_COLLECT_THRESHOLD = 20;

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

type NumericStage1Item = {
    fileId: number;
    hashes: PackedDHash[];
    /** Unique 12-bit bucket keys derived from each variant. */
    bucketKeys: string[];
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
     * Unite two components with no size limit.
     *
     * @returns whether two different components were merged.
     */
    union(left: number, right: number): boolean {
        const rootLeft = this.find(left);
        const rootRight = this.find(right);
        if (rootLeft === rootRight) {
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

/** Top 12 bits of the high limb as a 3-hex-char bucket key (matches hex.slice(0, 3)). */
const hashBucketKeyPacked = (hash: PackedDHash): string =>
    ((hash.high >>> 20) & 0xfff).toString(16).padStart(3, "0");

const toNumericItems = (items: Stage1Item[]): NumericStage1Item[] =>
    items.map((item) => {
        const hashes = item.hashes.map(parseDHashHex);
        const seen = new Set<string>();
        const bucketKeys: string[] = [];
        for (const hash of hashes) {
            const key = hashBucketKeyPacked(hash);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            bucketKeys.push(key);
        }
        return { fileId: item.fileId, hashes, bucketKeys };
    });

const buildHashBuckets = (
    items: NumericStage1Item[],
): Map<string, number[]> => {
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < items.length; i++) {
        for (const key of items[i]!.bucketKeys) {
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
    items: NumericStage1Item[],
    edgeDistanceByPair: Map<string, number>,
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
        clusters.push({
            fileIds: memberIndices.map((index) => items[index]!.fileId),
            furthestDistance: furthest,
        });
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

type CompareResult = {
    mergedTight: boolean;
    newEdges: CandidateEdge[];
};

/** @returns new edges added and whether a provisional tight-match merge occurred. */
const compareFileAgainstLaterBucketMates = (
    fileIndex: number,
    buckets: Map<string, number[]>,
    items: NumericStage1Item[],
    threshold: number,
    edgeByKey: Map<string, CandidateEdge>,
    provisionalUf: UnionFind,
): CompareResult => {
    const seenPartners = new Set<number>();
    const newEdges: CandidateEdge[] = [];
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
        const distance = variantHammingDistance(
            items[left]!.hashes,
            items[right]!.hashes,
        );
        if (distance > threshold) {
            return;
        }
        const edge: CandidateEdge = { left, right, distance };
        edgeByKey.set(key, edge);
        newEdges.push(edge);
        if (distance <= TIGHT_MATCH_DISTANCE) {
            if (provisionalUf.union(left, right)) {
                mergedTight = true;
            }
        }
    };

    for (const key of items[fileIndex]!.bucketKeys) {
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
    return { mergedTight, newEdges };
};

const finalizeClusters = (
    items: NumericStage1Item[],
    edgeByKey: Map<string, CandidateEdge>,
    clusterThreshold: number,
): Stage1Cluster[] => {
    const kept = new Map<string, CandidateEdge>();
    for (const [key, edge] of edgeByKey.entries()) {
        if (edge.distance <= clusterThreshold) {
            kept.set(key, edge);
        }
    }
    const mutual = filterMutualNearestEdges(kept);
    const uf = new UnionFind(items.length);
    const edgeDistanceByPair = new Map<string, number>();
    for (const edge of mutual) {
        uf.union(edge.left, edge.right);
        edgeDistanceByPair.set(`${edge.left}:${edge.right}`, edge.distance);
    }
    return clustersFromUnionFind(uf, items, edgeDistanceByPair);
};

/**
 * Cluster from CLIP score edges (distance = round(cosine * 100)).
 * No mutual-kNN here — confirm already happened when edges were collected.
 */
const finalizeClipScoreClusters = (
    items: NumericStage1Item[],
    edgeByKey: Map<string, CandidateEdge>,
    clusterThreshold: number,
): Stage1Cluster[] => {
    const uf = new UnionFind(items.length);
    const edgeDistanceByPair = new Map<string, number>();
    for (const edge of edgeByKey.values()) {
        if (edge.distance > clusterThreshold) {
            continue;
        }
        uf.union(edge.left, edge.right);
        edgeDistanceByPair.set(`${edge.left}:${edge.right}`, edge.distance);
    }
    return clustersFromUnionFind(uf, items, edgeDistanceByPair);
};

const edgesToFileEdges = (
    items: NumericStage1Item[],
    edgeByKey: Map<string, CandidateEdge>,
): Stage1FileEdge[] => {
    const edges: Stage1FileEdge[] = [];
    for (const edge of edgeByKey.values()) {
        edges.push({
            leftFileId: items[edge.left]!.fileId,
            rightFileId: items[edge.right]!.fileId,
            distance: edge.distance,
        });
    }
    return edges;
};

/**
 * CLIP-first Stage-1: each embedded file proposes its top-K CLIP neighbours
 * within the collect band; mutual (or tight) edges are confirmed, then
 * clustered at {@link threshold}.
 */
const runClipNearestClusteringCore = (
    items: Stage1Item[],
    embeddings: Stage1EmbeddingMap,
    threshold: number,
): Stage1ClusteringResult => {
    const numericItems = toNumericItems(items);
    const embedded: Array<{
        itemIndex: number;
        vector: ArrayLike<number>;
    }> = [];
    for (let i = 0; i < numericItems.length; i++) {
        const vector = embeddings.get(numericItems[i]!.fileId);
        if (vector?.length) {
            embedded.push({ itemIndex: i, vector });
        }
    }
    if (embedded.length < 2) {
        return { clusters: [], edges: [] };
    }

    const vectors = embedded.map((entry) => entry.vector);
    const topByIndex = findClipTopNeighbours(
        vectors,
        CLIP_CONFIRM_TOP_K,
        CLIP_SCORE_COLLECT_MAX,
    );
    const confirmed = collectConfirmedClipEdges(topByIndex);

    const edgeByKey = new Map<string, CandidateEdge>();
    for (const edge of confirmed) {
        const left = embedded[edge.left]!.itemIndex;
        const right = embedded[edge.right]!.itemIndex;
        const a = Math.min(left, right);
        const b = Math.max(left, right);
        edgeByKey.set(`${a}:${b}`, {
            left: a,
            right: b,
            distance: edge.score,
        });
    }

    return {
        clusters: finalizeClipScoreClusters(
            numericItems,
            edgeByKey,
            threshold,
        ),
        edges: edgesToFileEdges(numericItems, edgeByKey),
    };
};

/**
 * Async CLIP nearest-neighbour pass with progress + abort (worker-friendly).
 */
const runClipNearestClusteringAsync = async (
    items: Stage1Item[],
    embeddings: Stage1EmbeddingMap,
    threshold: number,
    onProgress: (update: Stage1ProgressUpdate) => void,
    shouldAbort?: () => boolean,
): Promise<Stage1ClusteringResult> => {
    const numericItems = toNumericItems(items);
    const embedded: Array<{
        itemIndex: number;
        vector: ArrayLike<number>;
    }> = [];
    for (let i = 0; i < numericItems.length; i++) {
        const vector = embeddings.get(numericItems[i]!.fileId);
        if (vector?.length) {
            embedded.push({ itemIndex: i, vector });
        }
    }
    const total = embedded.length;
    if (total < 2) {
        onProgress({ phase: "done", completed: 0, total: 0, clusters: [] });
        return { clusters: [], edges: [] };
    }

    const vectors = embedded.map((entry) => entry.vector);
    const topByIndex: Array<
        ReturnType<typeof findClipTopNeighboursForIndex>
    > = Array.from({ length: total }, () => []);
    const yieldEvery = Math.max(1, Math.min(32, Math.floor(total / 100) || 1));

    for (let i = 0; i < total; i++) {
        if (shouldAbort?.()) {
            throw new DOMException("Similarity grouping aborted", "AbortError");
        }
        topByIndex[i] = findClipTopNeighboursForIndex(
            vectors,
            i,
            CLIP_CONFIRM_TOP_K,
            CLIP_SCORE_COLLECT_MAX,
        );

        const completed = i + 1;
        if (completed % yieldEvery === 0 || completed === total) {
            onProgress({ phase: "comparing", completed, total });
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
        }
    }

    if (shouldAbort?.()) {
        throw new DOMException("Similarity grouping aborted", "AbortError");
    }

    const confirmed = collectConfirmedClipEdges(topByIndex);
    const edgeByKey = new Map<string, CandidateEdge>();
    for (const edge of confirmed) {
        const left = embedded[edge.left]!.itemIndex;
        const right = embedded[edge.right]!.itemIndex;
        const a = Math.min(left, right);
        const b = Math.max(left, right);
        edgeByKey.set(`${a}:${b}`, {
            left: a,
            right: b,
            distance: edge.score,
        });
    }

    const clusters = finalizeClipScoreClusters(
        numericItems,
        edgeByKey,
        threshold,
    );
    const edges = edgesToFileEdges(numericItems, edgeByKey);

    onProgress({
        phase: "finalizing",
        completed: total,
        total,
        clusters,
    });
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
    onProgress({ phase: "done", completed: total, total, clusters });
    return { clusters, edges };
};

/**
 * Recluster from cached file-id edges at a (possibly lower) threshold.
 * Sync and cheap. When {@link clip} is set, edges are CLIP scores (confirm
 * already applied at collect time) — threshold-filter only. Without CLIP,
 * edges are Hamming and mutual-kNN is reapplied.
 */
export const clusterFromFileEdges = (
    items: Stage1Item[],
    edges: Stage1FileEdge[],
    threshold: number,
    clip?: Stage1ClipOptions,
): Stage1Cluster[] => {
    if (items.length < 2) {
        return [];
    }
    const numericItems = toNumericItems(items);
    const indexByFileId = new Map(
        numericItems.map((item, index) => [item.fileId, index]),
    );
    const edgeByKey = new Map<string, CandidateEdge>();
    const collectMax =
        clip?.embeddings && clip.embeddings.size > 0 ?
            CLIP_SCORE_COLLECT_MAX :
            EDGE_COLLECT_THRESHOLD;
    for (const edge of edges) {
        if (edge.distance > collectMax) {
            continue;
        }
        const left = indexByFileId.get(edge.leftFileId);
        const right = indexByFileId.get(edge.rightFileId);
        if (left === undefined || right === undefined) {
            continue;
        }
        const a = Math.min(left, right);
        const b = Math.max(left, right);
        edgeByKey.set(`${a}:${b}`, {
            left: a,
            right: b,
            distance: edge.distance,
        });
    }
    if (clip?.embeddings && clip.embeddings.size > 0) {
        return finalizeClipScoreClusters(numericItems, edgeByKey, threshold);
    }
    return finalizeClusters(numericItems, edgeByKey, threshold);
};

/**
 * Sync Stage-1 for unit tests / small indexes. Same final algorithm as the
 * async path, without progress callbacks.
 */
export const runStage1ClusteringSync = (
    items: Stage1Item[],
    threshold: number,
    clip?: Stage1ClipOptions,
): Stage1Cluster[] => {
    if (items.length < 2) {
        return [];
    }
    if (clip?.embeddings && clip.embeddings.size >= 2) {
        return runClipNearestClusteringCore(items, clip.embeddings, threshold)
            .clusters;
    }
    const numericItems = toNumericItems(items);
    const buckets = buildHashBuckets(numericItems);
    const edgeByKey = new Map<string, CandidateEdge>();
    const provisionalUf = new UnionFind(numericItems.length);
    for (let i = 0; i < numericItems.length; i++) {
        compareFileAgainstLaterBucketMates(
            i,
            buckets,
            numericItems,
            threshold,
            edgeByKey,
            provisionalUf,
        );
    }
    return finalizeClusters(numericItems, edgeByKey, threshold);
};

/**
 * Async Stage-1 with per-image progress. With CLIP embeddings, runs
 * nearest-neighbour propose/confirm. Without, collects Hamming edges up to
 * {@link collectThreshold} (default {@link EDGE_COLLECT_THRESHOLD}) so callers
 * can recluster at lower thresholds without recomparing. Yields to the event
 * loop so worker `postMessage` progress reaches the UI thread.
 */
export const runStage1Clustering = async (
    items: Stage1Item[],
    threshold: number,
    onProgress: (update: Stage1ProgressUpdate) => void,
    shouldAbort?: () => boolean,
    collectThreshold: number = EDGE_COLLECT_THRESHOLD,
    clip?: Stage1ClipOptions,
): Promise<Stage1ClusteringResult> => {
    if (items.length < 2) {
        onProgress({
            phase: "done",
            completed: 0,
            total: 0,
            clusters: [],
        });
        return { clusters: [], edges: [] };
    }

    if (clip?.embeddings && clip.embeddings.size >= 2) {
        return runClipNearestClusteringAsync(
            items,
            clip.embeddings,
            threshold,
            onProgress,
            shouldAbort,
        );
    }

    const collectAt = Math.max(threshold, collectThreshold);
    const numericItems = toNumericItems(items);
    const buckets = buildHashBuckets(numericItems);
    const edgeByKey = new Map<string, CandidateEdge>();
    const provisionalUf = new UnionFind(numericItems.length);
    const provisionalDistances = new Map<string, number>();
    const total = numericItems.length;
    // Yield often enough for a live progress bar without drowning the main thread.
    const yieldEvery = Math.max(1, Math.min(48, Math.floor(total / 150) || 1));
    let lastClusterAt = 0;
    let clustersDirty = false;

    for (let i = 0; i < numericItems.length; i++) {
        if (shouldAbort?.()) {
            throw new DOMException("Similarity grouping aborted", "AbortError");
        }
        const { mergedTight, newEdges } = compareFileAgainstLaterBucketMates(
            i,
            buckets,
            numericItems,
            collectAt,
            edgeByKey,
            provisionalUf,
        );
        for (const edge of newEdges) {
            if (edge.distance <= threshold) {
                provisionalDistances.set(
                    `${edge.left}:${edge.right}`,
                    edge.distance,
                );
            }
        }
        if (mergedTight || newEdges.some((edge) => edge.distance <= threshold)) {
            clustersDirty = true;
        }

        const completed = i + 1;
        const now =
            typeof performance !== "undefined" ? performance.now() : Date.now();
        const dueForClusters =
            clustersDirty &&
            (completed === total ||
                now - lastClusterAt >= CLUSTER_PROGRESS_INTERVAL_MS);
        const shouldYield =
            completed % yieldEvery === 0 ||
            mergedTight ||
            completed === total;

        onProgress({
            phase: "comparing",
            completed,
            total,
            clusters: dueForClusters ?
                clustersFromUnionFind(
                    provisionalUf,
                    numericItems,
                    provisionalDistances,
                ) :
                undefined,
        });
        if (dueForClusters) {
            lastClusterAt = now;
            clustersDirty = false;
        }
        if (shouldYield) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
        }
    }

    if (shouldAbort?.()) {
        throw new DOMException("Similarity grouping aborted", "AbortError");
    }

    const edges = edgesToFileEdges(numericItems, edgeByKey);
    const finalClusters = finalizeClusters(
        numericItems,
        edgeByKey,
        threshold,
    );

    onProgress({
        phase: "finalizing",
        completed: total,
        total,
        clusters: finalClusters,
    });
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

    onProgress({
        phase: "done",
        completed: total,
        total,
        clusters: finalClusters,
    });
    return { clusters: finalClusters, edges };
};
