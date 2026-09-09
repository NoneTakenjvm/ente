import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import type { PhashEntry } from "@/lib/crop-match";
import { COLOR_PALETTE_THRESHOLD, hammingDistance } from "@/lib/crop-match";
import { variantHammingDistanceHex } from "@/lib/phash";
import { checkCropMatchBatchInWorkers } from "@/lib/similarity-job";
import {
    getCachedCropVerdict,
    setCachedCropVerdict,
} from "@/lib/similarity-match-cache";
import {
    MAX_GROUP_SIZE,
    runStage1ClusteringSync,
    type Stage1Cluster,
    type Stage1Item,
} from "@/lib/similarity-stage1-core";
import { MAX_SIMILAR_MAX_GROUP_SIZE } from "@/lib/app-settings";
import {
    collectionNameByID,
    normalOwnedCollections,
} from "@/lib/collections";
import {
    defaultKeeperFileId,
    type DedupGroupItem,
    type DedupGroupSelection,
} from "@/lib/dedup-prune";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";

export interface SimilarityGroup {
    id: string;
    items: DedupGroupItem[];
    maxDistance: number;
}

export const defaultSimilarityThreshold = 12;

/** 12-bit color prefix (was 8-bit / 2 hex — too coarse for 7k libraries). */
const colorBucketKey = (color: string): string => color.slice(0, 3);

/** Hard cap on crop checks paid per file within a color bucket. */
export const MAX_CROP_CHECKS_PER_FILE = 6;

/**
 * Hard cap on total Stage-2 crop pairs. Library-wide color buckets otherwise
 * produce ~O(n) candidates (~15k on a 7k library) and OOM the phone.
 */
export const MAX_TOTAL_CROP_CANDIDATES = 2000;

export {
    MAX_GROUP_SIZE,
    MUTUAL_RANK_K,
    TIGHT_MATCH_DISTANCE,
} from "@/lib/similarity-stage1-core";

export type SimilarMatchProgress = {
    stepDescription: string;
    completed: number;
    total: number;
};

class UnionFind {
    private readonly parent: number[];

    constructor(size: number) {
        this.parent = Array.from({ length: size }, (_, index) => index);
    }

    find(index: number): number {
        if (this.parent[index] !== index) {
            this.parent[index] = this.find(this.parent[index]!);
        }
        return this.parent[index]!;
    }

    /**
     * Unite two components with no size limit.
     * Display filtering ({@link trimSimilarityGroups}) hides oversized groups;
     * matching itself stays uncapped so true piles are not fragmented.
     */
    union(left: number, right: number): void {
        const rootLeft = this.find(left);
        const rootRight = this.find(right);
        if (rootLeft === rootRight) {
            return;
        }
        this.parent[rootRight] = rootLeft;
    }
}

const variantDistance = (left: string[], right: string[]): number =>
    variantHammingDistanceHex(left, right);

/** Only the owned, allowed-collection, non-archived image files that have a phash entry. */
export const indexableFiles = (
    entries: Map<number, PhashEntry>,
    filesById: Map<number, EnteFile>,
    collections: Collection[],
    userId: number,
): Array<{ fileId: number; entry: PhashEntry }> => {
    const ownedCollections = normalOwnedCollections(collections, userId);
    const allowedCollectionIDs = new Set(
        ownedCollections.map((collection) => collection.id),
    );

    const indexed: Array<{ fileId: number; entry: PhashEntry }> = [];
    for (const [fileId, entry] of entries.entries()) {
        const file = filesById.get(fileId);
        if (!file) {
            continue;
        }
        if (file.ownerID !== userId) {
            continue;
        }
        if (isFileArchivedLocally(file)) {
            continue;
        }
        if (!allowedCollectionIDs.has(file.collectionID)) {
            continue;
        }
        if (file.metadata.fileType !== FileType.image) {
            continue;
        }
        indexed.push({ fileId, entry });
    }
    return indexed;
};

export const toStage1Items = (
    indexed: Array<{ fileId: number; entry: PhashEntry }>,
): Stage1Item[] =>
    indexed.map(({ fileId, entry }) => ({
        fileId,
        hashes: entry.hashes,
    }));

/**
 * Turn worker/core clusters into UI {@link SimilarityGroup}s using library files.
 */
export const clustersToSimilarityGroups = (
    clusters: Stage1Cluster[],
    filesById: Map<number, EnteFile>,
    collections: Collection[],
    userId: number,
): SimilarityGroup[] => {
    const ownedCollections = normalOwnedCollections(collections, userId);
    const names = collectionNameByID(ownedCollections);
    const groups: SimilarityGroup[] = [];

    for (const cluster of clusters) {
        const items: DedupGroupItem[] = [];
        for (const fileId of cluster.fileIds) {
            const file = filesById.get(fileId);
            if (!file) {
                continue;
            }
            const collectionName = names.get(file.collectionID);
            if (!collectionName) {
                continue;
            }
            items.push({
                file,
                collectionIDs: new Set([file.collectionID]),
                collectionName,
            });
        }
        if (items.length < 2) {
            continue;
        }
        items.sort((a, b) => a.collectionName.localeCompare(b.collectionName));
        groups.push({
            id: `similar-${items.map((item) => item.file.id).sort((a, b) => a - b).join("-")}`,
            items,
            maxDistance: cluster.furthestDistance,
        });
    }

    return groups.sort((a, b) => b.items.length - a.items.length);
};

/**
 * Keep only groups whose size is in [2, maxGroupSize]. Larger natural clusters
 * are hidden (not sliced) — oversized piles are usually false-positive chains,
 * and slicing them manufactures hundreds of useless cards.
 */
export const trimSimilarityGroups = (
    groups: SimilarityGroup[],
    maxGroupSize: number,
): SimilarityGroup[] => {
    if (maxGroupSize < 2) {
        return [];
    }
    return groups
        .filter(
            (group) =>
                group.items.length >= 2 &&
                group.items.length <= maxGroupSize,
        )
        .sort((a, b) => b.items.length - a.items.length);
};

/**
 * Stage-1 (sync): for tests. Production UI uses {@link runStage1InWorker} from
 * `@/lib/similarity-job`.
 */
export const buildSimilarityGroups = (
    entries: Map<number, PhashEntry>,
    filesById: Map<number, EnteFile>,
    collections: Collection[],
    userId: number,
    threshold: number,
    maxGroupSize: number = MAX_GROUP_SIZE,
): SimilarityGroup[] => {
    const indexed = indexableFiles(entries, filesById, collections, userId);
    if (indexed.length < 2) {
        return [];
    }
    const clusters = runStage1ClusteringSync(toStage1Items(indexed), threshold);
    return trimSimilarityGroups(
        clustersToSimilarityGroups(clusters, filesById, collections, userId),
        maxGroupSize,
    );
};

/** Skip O(k²) max-distance when a component is this large (display will hide it anyway). */
const MAX_DISTANCE_PAIRWISE_MEMBERS = 48;

const assembleGroup = (
    memberIndices: number[],
    indexed: Array<{ fileId: number; entry: PhashEntry }>,
    filesById: Map<number, EnteFile>,
    collections: Collection[],
    userId: number,
    computeMaxDistance = true,
): SimilarityGroup | undefined => {
    const ownedCollections = normalOwnedCollections(collections, userId);
    const names = collectionNameByID(ownedCollections);

    const items: DedupGroupItem[] = [];
    let maxDistance = 0;
    const memberHashes: string[][] = [];

    for (const index of memberIndices) {
        const { fileId, entry } = indexed[index]!;
        memberHashes.push(entry.hashes);
        const file = filesById.get(fileId);
        if (!file) {
            continue;
        }
        const collectionName = names.get(file.collectionID);
        if (!collectionName) {
            continue;
        }
        items.push({
            file,
            collectionIDs: new Set([file.collectionID]),
            collectionName,
        });
    }

    if (items.length < 2) {
        return undefined;
    }

    if (
        computeMaxDistance &&
        memberHashes.length <= MAX_DISTANCE_PAIRWISE_MEMBERS
    ) {
        for (let i = 0; i < memberHashes.length; i++) {
            for (let j = i + 1; j < memberHashes.length; j++) {
                maxDistance = Math.max(
                    maxDistance,
                    variantDistance(memberHashes[i]!, memberHashes[j]!),
                );
            }
        }
    }

    items.sort((a, b) => a.collectionName.localeCompare(b.collectionName));

    return {
        id: `similar-${items.map((item) => item.file.id).sort((a, b) => a - b).join("-")}`,
        items,
        maxDistance,
    };
};

export interface CropMergeOptions {
    entries: Map<number, PhashEntry>;
    filesById: Map<number, EnteFile>;
    collections: Collection[];
    userId: number;
    batchSize?: number;
    signal?: AbortSignal;
    onProgress?: (progress: SimilarMatchProgress) => void;
    onGroups?: (groups: SimilarityGroup[]) => void;
    maxGroupSize?: number;
    /**
     * Preferred Stage-1 seed (file-id clusters). Avoids assembling huge
     * SimilarityGroups just to union them before crop checks.
     */
    stage1Clusters?: Stage1Cluster[];
}

/** Soft throttle for provisional group rebuilds during crop merge (ms). */
const CROP_GROUP_PROGRESS_INTERVAL_MS = 800;

/**
 * Stage-2: refine Stage-1 groups by linking crop matches via the worker pool.
 *
 * Matching is uncapped (natural clusters). Candidates are color-bucketed; within
 * each bucket neighbours are ranked by color Hamming (not lex order) before the
 * per-file / total pair caps apply, so large libraries cannot enqueue tens of
 * thousands of template matches. Callers filter oversized groups for display
 * via {@link trimSimilarityGroups}.
 */
export const mergeCropMatches = async (
    groups: SimilarityGroup[],
    options: CropMergeOptions,
): Promise<SimilarityGroup[]> => {
    const {
        entries,
        filesById,
        collections,
        userId,
        batchSize = 48,
        signal,
        onProgress,
        onGroups,
        maxGroupSize = MAX_GROUP_SIZE,
        stage1Clusters,
    } = options;

    const throwIfAborted = (): void => {
        if (signal?.aborted) {
            throw new DOMException("Crop merge aborted", "AbortError");
        }
    };

    throwIfAborted();

    const indexed = indexableFiles(entries, filesById, collections, userId);
    const cropEligible = indexed.filter(
        ({ entry }) => entry.color !== undefined && entry.grid !== undefined,
    );

    if (indexed.length < 2 || cropEligible.length < 2) {
        if (stage1Clusters && stage1Clusters.length > 0) {
            const displayable = stage1Clusters.filter(
                (cluster) =>
                    cluster.fileIds.length >= 2 &&
                    cluster.fileIds.length <= MAX_SIMILAR_MAX_GROUP_SIZE,
            );
            return clustersToSimilarityGroups(
                displayable,
                filesById,
                collections,
                userId,
            );
        }
        return groups;
    }

    const fileIds = indexed.map(({ fileId }) => fileId);
    const indexById = new Map(fileIds.map((fileId, i) => [fileId, i]));
    const uf = new UnionFind(fileIds.length);

    const seedMemberIndexes = (memberIndexes: number[]): void => {
        if (memberIndexes.length < 2) {
            return;
        }
        const first = memberIndexes[0]!;
        for (const index of memberIndexes.slice(1)) {
            uf.union(first, index);
        }
    };

    const stage1MemberIndexes = new Set<number>();
    if (stage1Clusters && stage1Clusters.length > 0) {
        for (const cluster of stage1Clusters) {
            const memberIndexes = cluster.fileIds
                .map((fileId) => indexById.get(fileId))
                .filter((index): index is number => index !== undefined);
            for (const index of memberIndexes) {
                stage1MemberIndexes.add(index);
            }
            seedMemberIndexes(memberIndexes);
        }
    } else {
        for (const group of groups) {
            const memberIndexes = group.items
                .map((item) => indexById.get(item.file.id))
                .filter((index): index is number => index !== undefined);
            for (const index of memberIndexes) {
                stage1MemberIndexes.add(index);
            }
            seedMemberIndexes(memberIndexes);
        }
    }

    const buckets = new Map<string, number[]>();
    for (const { fileId, entry } of cropEligible) {
        const prefix = colorBucketKey(entry.color!);
        const index = indexById.get(fileId)!;
        const bucket = buckets.get(prefix);
        if (bucket) {
            bucket.push(index);
        } else {
            buckets.set(prefix, [index]);
        }
    }
    /**
     * Within each color bucket, pick each file's nearest palette neighbours by
     * Hamming distance (not lex-adjacent hex). That keeps the per-file / total
     * pair caps but spends them on siblings that are actually close in color.
     */
    const preferred: Array<[number, number]> = [];
    const other: Array<[number, number]> = [];
    const seenPairs = new Set<string>();
    for (const bucketIndexes of buckets.values()) {
        for (let p = 0; p < bucketIndexes.length; p++) {
            const a = bucketIndexes[p]!;
            const colorA = indexed[a]!.entry.color!;
            const neighbours: Array<{ index: number; distance: number }> = [];
            for (let q = 0; q < bucketIndexes.length; q++) {
                if (q === p) {
                    continue;
                }
                const b = bucketIndexes[q]!;
                if (uf.find(a) === uf.find(b)) {
                    continue;
                }
                const distance = hammingDistance(
                    colorA,
                    indexed[b]!.entry.color!,
                );
                if (distance > COLOR_PALETTE_THRESHOLD) {
                    continue;
                }
                neighbours.push({ index: b, distance });
            }
            neighbours.sort((left, right) => {
                if (left.distance !== right.distance) {
                    return left.distance - right.distance;
                }
                return left.index - right.index;
            });
            for (const neighbour of neighbours.slice(
                0,
                MAX_CROP_CHECKS_PER_FILE,
            )) {
                const b = neighbour.index;
                const lo = Math.min(a, b);
                const hi = Math.max(a, b);
                const key = `${lo}:${hi}`;
                if (seenPairs.has(key)) {
                    continue;
                }
                seenPairs.add(key);
                const pair: [number, number] = [a, b];
                if (
                    stage1MemberIndexes.has(a) ||
                    stage1MemberIndexes.has(b)
                ) {
                    preferred.push(pair);
                } else {
                    other.push(pair);
                }
            }
        }
    }
    const candidates = [...preferred, ...other].slice(
        0,
        MAX_TOTAL_CROP_CANDIDATES,
    );

    const rebuildGroups = (computeMaxDistance: boolean): SimilarityGroup[] => {
        const groupsByRoot = new Map<number, number[]>();
        for (let i = 0; i < indexed.length; i++) {
            const root = uf.find(i);
            const members = groupsByRoot.get(root);
            if (members) {
                members.push(i);
            } else {
                groupsByRoot.set(root, [i]);
            }
        }
        const rebuilt: SimilarityGroup[] = [];
        for (const memberIndices of groupsByRoot.values()) {
            // Never displayable with the settings max (1–5); skip assembly.
            if (
                memberIndices.length < 2 ||
                memberIndices.length > MAX_SIMILAR_MAX_GROUP_SIZE
            ) {
                continue;
            }
            const group = assembleGroup(
                memberIndices,
                indexed,
                filesById,
                collections,
                userId,
                computeMaxDistance,
            );
            if (group) {
                rebuilt.push(group);
            }
        }
        return rebuilt.sort((a, b) => b.items.length - a.items.length);
    };

    const emitGroups = (computeMaxDistance: boolean): SimilarityGroup[] => {
        const full = rebuildGroups(computeMaxDistance);
        onGroups?.(trimSimilarityGroups(full, maxGroupSize));
        return full;
    };

    const applyCachedUnion = (a: number, b: number): void => {
        if (
            getCachedCropVerdict(indexed[a]!.fileId, indexed[b]!.fileId) &&
            uf.find(a) !== uf.find(b)
        ) {
            uf.union(a, b);
        }
    };

    // All pairs already verified this session — apply sync (threshold changes).
    let allCached = candidates.length > 0;
    for (const [a, b] of candidates) {
        if (
            getCachedCropVerdict(indexed[a]!.fileId, indexed[b]!.fileId) ===
            undefined
        ) {
            allCached = false;
            break;
        }
    }
    if (allCached) {
        for (const [a, b] of candidates) {
            applyCachedUnion(a, b);
        }
        return emitGroups(true);
    }

    if (candidates.length === 0) {
        return emitGroups(true);
    }

    let lastGroupsAt = 0;
    let groupsDirty = false;

    for (let start = 0; start < candidates.length; start += batchSize) {
        throwIfAborted();
        const batch = candidates.slice(start, start + batchSize);
        const activePairs: Array<[number, number]> = [];
        for (const [a, b] of batch) {
            if (uf.find(a) === uf.find(b)) {
                continue;
            }
            activePairs.push([a, b]);
        }

        if (activePairs.length > 0) {
            const cachedMatches: boolean[] = [];
            const uncachedPairs: Array<[number, number]> = [];
            const uncachedSlots: number[] = [];
            activePairs.forEach(([a, b], slot) => {
                const cached = getCachedCropVerdict(
                    indexed[a]!.fileId,
                    indexed[b]!.fileId,
                );
                if (cached !== undefined) {
                    cachedMatches[slot] = cached;
                    return;
                }
                uncachedSlots.push(slot);
                uncachedPairs.push([a, b]);
            });

            if (uncachedPairs.length > 0) {
                const batchEntries: Record<
                    string,
                    { color: string; grid: string }
                > = {};
                const keyPairs: Array<[string, string]> = [];
                for (const [a, b] of uncachedPairs) {
                    const aKey = String(a);
                    const bKey = String(b);
                    if (!batchEntries[aKey]) {
                        const left = indexed[a]!.entry;
                        batchEntries[aKey] = {
                            color: left.color!,
                            grid: left.grid!,
                        };
                    }
                    if (!batchEntries[bKey]) {
                        const right = indexed[b]!.entry;
                        batchEntries[bKey] = {
                            color: right.color!,
                            grid: right.grid!,
                        };
                    }
                    keyPairs.push([aKey, bKey]);
                }

                const verdicts = await checkCropMatchBatchInWorkers(
                    batchEntries,
                    keyPairs,
                );
                throwIfAborted();
                verdicts.forEach((match, index) => {
                    const [a, b] = uncachedPairs[index]!;
                    setCachedCropVerdict(
                        indexed[a]!.fileId,
                        indexed[b]!.fileId,
                        match,
                    );
                    cachedMatches[uncachedSlots[index]!] = match;
                });
            }

            activePairs.forEach(([a, b], slot) => {
                if (!cachedMatches[slot]) {
                    return;
                }
                uf.union(a, b);
                groupsDirty = true;
            });
        }

        const completed = Math.min(start + batch.length, candidates.length);
        const now =
            typeof performance !== "undefined" ? performance.now() : Date.now();
        const isLast = completed >= candidates.length;
        const dueForGroups =
            Boolean(onGroups) &&
            groupsDirty &&
            (isLast || now - lastGroupsAt >= CROP_GROUP_PROGRESS_INTERVAL_MS);

        onProgress?.({
            stepDescription: "Checking crops",
            completed,
            total: Math.max(candidates.length, 1),
        });
        if (dueForGroups) {
            // Skip O(k²) distance during progress; final emit computes it.
            emitGroups(false);
            lastGroupsAt = now;
            groupsDirty = false;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throwIfAborted();
    return emitGroups(true);
};

export const similarityGroupToSelection = (
    group: SimilarityGroup,
    isSelected = false,
): DedupGroupSelection => ({
    id: group.id,
    items: group.items,
    keeperFileId: defaultKeeperFileId(group.items),
    isSelected,
});
