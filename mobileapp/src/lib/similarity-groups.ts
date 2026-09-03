import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import type { PhashEntry } from "@/lib/crop-match";
import { hammingDistance } from "@/lib/phash";
import { checkCropMatchInWorkers } from "@/lib/similarity-job";
import {
    MAX_GROUP_SIZE,
    runStage1ClusteringSync,
    type Stage1Cluster,
    type Stage1Item,
} from "@/lib/similarity-stage1-core";
import {
    collectionNameByID,
    normalOwnedCollections,
} from "@/lib/collections";
import {
    defaultKeeperFileId,
    type DedupGroupItem,
    type DedupGroupSelection,
} from "@/lib/dedup-prune";

export interface SimilarityGroup {
    id: string;
    items: DedupGroupItem[];
    maxDistance: number;
}

export const defaultSimilarityThreshold = 8;

const colorBucketKey = (color: string): string => color.slice(0, 2);

/** Hard cap on crop checks paid per file, so the async pass stays bounded. */
export const MAX_CROP_CHECKS_PER_FILE = 4;

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

    componentSize(index: number): number {
        return this.sizes[this.find(index)]!;
    }

    union(left: number, right: number): void {
        const rootLeft = this.find(left);
        const rootRight = this.find(right);
        if (rootLeft === rootRight) {
            return;
        }
        if (this.sizes[rootLeft]! < this.sizes[rootRight]!) {
            this.parent[rootLeft] = rootRight;
            this.sizes[rootRight]! += this.sizes[rootLeft]!;
        } else {
            this.parent[rootRight] = rootLeft;
            this.sizes[rootLeft]! += this.sizes[rootRight]!;
        }
    }

    tryUnion(left: number, right: number, maxSize: number): boolean {
        const rootLeft = this.find(left);
        const rootRight = this.find(right);
        if (rootLeft === rootRight) {
            return true;
        }
        if (this.sizes[rootLeft]! + this.sizes[rootRight]! > maxSize) {
            return false;
        }
        this.union(left, right);
        return true;
    }
}

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

/** Only the owned, allowed-collection, image files that have a phash entry. */
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
    const clusters = runStage1ClusteringSync(
        toStage1Items(indexed),
        threshold,
        maxGroupSize,
    );
    return clustersToSimilarityGroups(clusters, filesById, collections, userId);
};

const assembleGroup = (
    memberIndices: number[],
    indexed: Array<{ fileId: number; entry: PhashEntry }>,
    filesById: Map<number, EnteFile>,
    collections: Collection[],
    userId: number,
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

    for (let i = 0; i < memberHashes.length; i++) {
        for (let j = i + 1; j < memberHashes.length; j++) {
            maxDistance = Math.max(
                maxDistance,
                variantDistance(memberHashes[i]!, memberHashes[j]!),
            );
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
}

/**
 * Stage-2: refine Stage-1 groups by linking crop matches via the worker pool.
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
        return groups;
    }

    const fileIds = indexed.map(({ fileId }) => fileId);
    const indexById = new Map(fileIds.map((fileId, i) => [fileId, i]));
    const uf = new UnionFind(fileIds.length);

    for (const group of groups) {
        const memberIndexes = group.items
            .map((item) => indexById.get(item.file.id))
            .filter((index): index is number => index !== undefined);
        if (memberIndexes.length < 2) {
            continue;
        }
        const first = memberIndexes[0]!;
        for (const index of memberIndexes.slice(1)) {
            uf.union(first, index);
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
    for (const bucketIndexes of buckets.values()) {
        bucketIndexes.sort((a, b) =>
            indexed[a]!.entry.color!.localeCompare(indexed[b]!.entry.color!));
    }

    const candidates: Array<[number, number]> = [];
    for (const bucketIndexes of buckets.values()) {
        for (let p = 0; p < bucketIndexes.length; p++) {
            for (
                let offset = 1;
                offset <= MAX_CROP_CHECKS_PER_FILE && p + offset < bucketIndexes.length;
                offset++
            ) {
                const a = bucketIndexes[p]!;
                const b = bucketIndexes[p + offset]!;
                if (uf.find(a) === uf.find(b)) {
                    continue;
                }
                if (uf.componentSize(a) + uf.componentSize(b) > maxGroupSize) {
                    continue;
                }
                candidates.push([a, b]);
            }
        }
    }

    const rebuildGroups = (): SimilarityGroup[] => {
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
            if (memberIndices.length < 2) {
                continue;
            }
            if (memberIndices.length > maxGroupSize) {
                for (let i = 0; i < memberIndices.length; i += maxGroupSize) {
                    const slice = memberIndices.slice(i, i + maxGroupSize);
                    const group = assembleGroup(
                        slice,
                        indexed,
                        filesById,
                        collections,
                        userId,
                    );
                    if (group) {
                        rebuilt.push(group);
                    }
                }
                continue;
            }
            const group = assembleGroup(
                memberIndices,
                indexed,
                filesById,
                collections,
                userId,
            );
            if (group) {
                rebuilt.push(group);
            }
        }
        return rebuilt.sort((a, b) => b.items.length - a.items.length);
    };

    for (let start = 0; start < candidates.length; start += batchSize) {
        throwIfAborted();
        const batch = candidates.slice(start, start + batchSize);
        const verdicts = await Promise.all(
            batch.map(([a, b]) => {
                if (uf.find(a) === uf.find(b)) {
                    return Promise.resolve(false);
                }
                if (uf.componentSize(a) + uf.componentSize(b) > maxGroupSize) {
                    return Promise.resolve(false);
                }
                const left = indexed[a]!.entry;
                const right = indexed[b]!.entry;
                return checkCropMatchInWorkers(
                    left.color!,
                    left.grid!,
                    right.color!,
                    right.grid!,
                );
            }),
        );
        throwIfAborted();
        verdicts.forEach((match, index) => {
            if (!match) {
                return;
            }
            const [a, b] = batch[index]!;
            uf.tryUnion(a, b, maxGroupSize);
        });

        const completed = Math.min(start + batch.length, candidates.length);
        onProgress?.({
            stepDescription: "Checking crops",
            completed,
            total: Math.max(candidates.length, 1),
        });
        onGroups?.(rebuildGroups());
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throwIfAborted();
    return rebuildGroups();
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
