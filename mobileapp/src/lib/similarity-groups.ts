import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import {
    areCropMatches,
    type PhashEntry,
} from "@/lib/crop-match";
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
const colorBucketKey = (color: string): string => color.slice(0, 2);

/** Hard cap on crop checks paid per file, so the async pass stays bounded. */
export const MAX_CROP_CHECKS_PER_FILE = 4;

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

/** Distance between two files across every rotation/mirror variant pair. */
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
const indexableFiles = (
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

/**
 * Stage-1: build similarity groups from the dHash-variant index using
 * union-find. This catches identical and rotation/mirror duplicates fast.
 * Crops are added later by {@link mergeCropMatches}.
 */
export const buildSimilarityGroups = (
    entries: Map<number, PhashEntry>,
    filesById: Map<number, EnteFile>,
    collections: Collection[],
    userId: number,
    threshold: number,
): SimilarityGroup[] => {
    const indexed = indexableFiles(entries, filesById, collections, userId);

    if (indexed.length < 2) {
        return [];
    }

    // Bucket by the prefix of each variant hash, so a rotated file's variant
    // that matches the source's orientation lands in the same bucket.
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < indexed.length; i++) {
        const seen = new Set<string>();
        for (const hash of indexed[i]!.entry.hashes) {
            const key = hashBucketKey(hash);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            buckets.set(key, [...(buckets.get(key) ?? []), i]);
        }
    }

    const uf = new UnionFind(indexed.length);
    const bucketKeys = [...buckets.keys()];

    // Union a comparable pair if any of their variants are within threshold.
    const unionIfSimilar = (leftIndex: number, rightIndex: number): void => {
        const left = indexed[leftIndex]!;
        const right = indexed[rightIndex]!;
        if (variantDistance(left.entry.hashes, right.entry.hashes) <= threshold) {
            uf.union(leftIndex, rightIndex);
        }
    };

    for (const key of bucketKeys) {
        const indices = buckets.get(key) ?? [];
        for (let i = 0; i < indices.length; i++) {
            for (let j = i + 1; j < indices.length; j++) {
                unionIfSimilar(indices[i]!, indices[j]!);
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
                    unionIfSimilar(leftIndex, rightIndex);
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
        const group = assembleGroup(memberIndices, indexed, filesById, collections, userId);
        if (group) {
            groups.push(group);
        }
    }

    return groups.sort((a, b) => b.items.length - a.items.length);
};

/**
 * Build the {@link SimilarityGroup} for a set of indexes into `indexed`.
 */
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
    /** Yield to the event loop every N crop checks. */
    yieldEvery?: number;
}

/**
 * Stage-2: refine the Stage-1 groups by linking cross-group (or singleton)
 * pairs that are the same photo under a crop. Color proposes candidates; the
 * template match verifies them. Runs asynchronously in chunks to keep the main
 * thread responsive.
 */
export const mergeCropMatches = async (
    groups: SimilarityGroup[],
    options: CropMergeOptions,
): Promise<SimilarityGroup[]> => {
    const { entries, filesById, collections, userId, yieldEvery = 32 } = options;

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

    // Seed the union-find with the Stage-1 group memberships so crop checks
    // merge groups across what dHash already found.
    for (const group of groups) {
        const memberIndexes = group.items
            .map((item) => indexById.get(item.file.id))
            .filter((index) => index !== undefined) as number[];
        if (memberIndexes.length < 2) {
            continue;
        }
        const first = memberIndexes[0]!;
        for (const index of memberIndexes.slice(1)) {
            uf.union(first, index);
        }
    }

    // Color buckets: coarse prefix, sorted by full color so similar palettes sit
    // adjacent; each file checks at most MAX_CROP_CHECKS_PER_FILE nearest ones.
    const buckets = new Map<string, number[]>();
    for (const { fileId, entry } of cropEligible) {
        const prefix = colorBucketKey(entry.color!);
        buckets.set(prefix, [...(buckets.get(prefix) ?? []), indexById.get(fileId)!]);
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
                if (uf.find(a) !== uf.find(b)) {
                    candidates.push([a, b]);
                }
            }
        }
    }

    for (let i = 0; i < candidates.length; i++) {
        if (i % yieldEvery === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const [a, b] = candidates[i]!;
        if (uf.find(a) === uf.find(b)) {
            continue;
        }
        const left = indexed[a]!.entry;
        const right = indexed[b]!.entry;
        if (
            left.color !== undefined && left.grid !== undefined &&
            right.color !== undefined && right.grid !== undefined &&
            areCropMatches(left.color, left.grid, right.color, right.grid)
        ) {
            uf.union(a, b);
        }
    }

    const groupsByRoot = new Map<number, number[]>();
    for (let i = 0; i < indexed.length; i++) {
        const root = uf.find(i);
        groupsByRoot.set(root, [...(groupsByRoot.get(root) ?? []), i]);
    }

    const rebuilt: SimilarityGroup[] = [];
    for (const memberIndices of groupsByRoot.values()) {
        if (memberIndices.length < 2) {
            continue;
        }
        const group = assembleGroup(memberIndices, indexed, filesById, collections, userId);
        if (group) {
            rebuilt.push(group);
        }
    }

    return rebuilt.sort((a, b) => b.items.length - a.items.length);
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
