import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import { hammingDistance } from "@/lib/phash";
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

export const defaultSimilarityThreshold = 10;

const hashBucketKey = (hash: string): string => hash.slice(0, 3);

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

    union(left: number, right: number): void {
        const rootLeft = this.find(left);
        const rootRight = this.find(right);
        if (rootLeft !== rootRight) {
            this.parent[rootRight] = rootLeft;
        }
    }
}

/**
 * Build similarity groups from a fileId → dHash index using union-find.
 */
export const buildSimilarityGroups = (
    entries: Map<number, string>,
    filesById: Map<number, EnteFile>,
    collections: Collection[],
    userId: number,
    threshold: number,
): SimilarityGroup[] => {
    const ownedCollections = normalOwnedCollections(collections, userId);
    const names = collectionNameByID(ownedCollections);
    const allowedCollectionIDs = new Set(
        ownedCollections.map((collection) => collection.id),
    );

    const indexed: Array<{ fileId: number; hash: string }> = [];
    for (const [fileId, hash] of entries.entries()) {
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
        indexed.push({ fileId, hash });
    }

    if (indexed.length < 2) {
        return [];
    }

    const buckets = new Map<string, number[]>();
    for (let i = 0; i < indexed.length; i++) {
        const key = hashBucketKey(indexed[i]!.hash);
        buckets.set(key, [...(buckets.get(key) ?? []), i]);
    }

    const uf = new UnionFind(indexed.length);
    const bucketKeys = [...buckets.keys()];

    for (const key of bucketKeys) {
        const indices = buckets.get(key) ?? [];
        for (let i = 0; i < indices.length; i++) {
            for (let j = i + 1; j < indices.length; j++) {
                const left = indexed[indices[i]!]!;
                const right = indexed[indices[j]!]!;
                if (hammingDistance(left.hash, right.hash) <= threshold) {
                    uf.union(indices[i]!, indices[j]!);
                }
            }
        }

        const keyValue = Number.parseInt(key, 16);
        for (const delta of [-1, 1]) {
            const neighborKey = (keyValue + delta)
                .toString(16)
                .padStart(3, "0")
                .slice(-3);
            const neighborIndices = buckets.get(neighborKey);
            if (!neighborIndices) {
                continue;
            }
            for (const leftIndex of indices) {
                for (const rightIndex of neighborIndices) {
                    const left = indexed[leftIndex]!;
                    const right = indexed[rightIndex]!;
                    if (hammingDistance(left.hash, right.hash) <= threshold) {
                        uf.union(leftIndex, rightIndex);
                    }
                }
            }
        }
    }

    const groupsByRoot = new Map<number, number[]>();
    for (let i = 0; i < indexed.length; i++) {
        const root = uf.find(i);
        groupsByRoot.set(root, [...(groupsByRoot.get(root) ?? []), i]);
    }

    const groups: SimilarityGroup[] = [];

    for (const memberIndices of groupsByRoot.values()) {
        if (memberIndices.length < 2) {
            continue;
        }

        const items: DedupGroupItem[] = [];
        let maxDistance = 0;
        const hashes: string[] = [];

        for (const index of memberIndices) {
            const { fileId, hash } = indexed[index]!;
            hashes.push(hash);
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

        for (let i = 0; i < hashes.length; i++) {
            for (let j = i + 1; j < hashes.length; j++) {
                maxDistance = Math.max(
                    maxDistance,
                    hammingDistance(hashes[i]!, hashes[j]!),
                );
            }
        }

        items.sort((a, b) =>
            a.collectionName.localeCompare(b.collectionName));

        groups.push({
            id: `similar-${items.map((item) => item.file.id).sort((a, b) => a - b).join("-")}`,
            items,
            maxDistance,
        });
    }

    return groups.sort((a, b) => b.items.length - a.items.length);
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
