import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import type { PhashEntry } from "@/lib/crop-match";
import { hammingDistance } from "@/lib/phash";
import { checkCropMatchInWorkers } from "@/lib/similarity-job";
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

/**
 * Hard cap on a single similarity group. Real duplicate groups (near-identical /
 * rotate-crop copies) are small; anything ballooning past this is a chained
 * union-find artifact (A~B, B~C ⇒ A,B,C grouped even when A≁C). Oversized
 * components are re-clustered by strict-prefix single-linkage so the loose
 * "bridge" links are dropped rather than unioned across.
 */
export const MAX_GROUP_SIZE = 40;

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

    /** Number of members in the component containing `index`. */
    componentSize(index: number): number {
        return this.sizes[this.find(index)]!;
    }

    union(left: number, right: number): void {
        const rootLeft = this.find(left);
        const rootRight = this.find(right);
        if (rootLeft === rootRight) {
            return;
        }
        // Union by size so roots stay representative of the larger side.
        if (this.sizes[rootLeft]! < this.sizes[rootRight]!) {
            this.parent[rootLeft] = rootRight;
            this.sizes[rootRight]! += this.sizes[rootLeft]!;
        } else {
            this.parent[rootRight] = rootLeft;
            this.sizes[rootLeft]! += this.sizes[rootRight]!;
        }
    }

    /**
     * Union only when the merged component would stay within `maxSize`.
     * Returns whether the two indices share a component afterwards.
     */
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
            const bucket = buckets.get(key);
            if (bucket) {
                bucket.push(i);
            } else {
                buckets.set(key, [i]);
            }
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
        const members = groupsByRoot.get(root);
        if (members) {
            members.push(i);
        } else {
            groupsByRoot.set(root, [i]);
        }
    }

    const groups: SimilarityGroup[] = [];
    for (const memberIndices of groupsByRoot.values()) {
        if (memberIndices.length < 2) {
            continue;
        }
        // A component that exploded past the cap is a union-find chaining
        // artifact. Re-cluster it by single-linkage — strict hash-prefix buckets
        // plus a tight best-variant distance — so near-identical duplicates
        // survive while the loose "bridge" links get dropped, never re-chained.
        const clusters =
            memberIndices.length > MAX_GROUP_SIZE ?
                reclusterOversized(memberIndices, indexed, threshold) :
                [memberIndices];
        for (const cluster of clusters) {
            const group = assembleGroup(cluster, indexed, filesById, collections, userId);
            if (group) {
                groups.push(group);
            }
        }
    }

    return groups.sort((a, b) => b.items.length - a.items.length);
};

/**
 * Split an oversized union-find component into tighter clusters.
 *
 * The original union-find was transitive: A~B and B~C implies A~C, which is
 * how distinct photos chain into one giant group. We can't un-transitivize a
 * single shared component, so we re-partition it here by recursive strict
 * single-linkage:
 *
 *   - Level 1 links two images only if some *exact* hash prefix holds both of
 *     them AND their best variant distance is at most half the normal
 *     threshold. Genuine duplicates match near 0-4 on a shared prefix, so they
 *     stay together; the loose "bridge" links crossing prefixes are dropped
 *     deterministically (no ±1 neighbor buckets, unlike the outer pass).
 *   - If a re-clustered group still exceeds {@link MAX_GROUP_SIZE}, we recurse
 *     with a longer hash prefix, which subdivides the bucket until the group is
 *     bounded. This terminates at the full 64-bit hash: a bucket there is a set
 *     of images sharing an identical variant — true exact copies.
 *   - As a hard floor, an exact-identical cluster above the cap is sliced into
 *     bounded deterministic chunks (they are true duplicates; a handful of
 *     bounded groups is strictly better than one absurd one).
 */
const reclusterOversized = (
    memberIndices: number[],
    indexed: Array<{ fileId: number; entry: PhashEntry }>,
    threshold: number,
): number[][] => {
    const clusters = reclusterByPrefix(memberIndices, indexed, threshold, 1);
    const bounded: number[][] = [];
    for (const cluster of clusters) {
        if (cluster.length <= MAX_GROUP_SIZE) {
            bounded.push(cluster);
            continue;
        }
        for (let i = 0; i < cluster.length; i += MAX_GROUP_SIZE) {
            bounded.push(cluster.slice(i, i + MAX_GROUP_SIZE));
        }
    }
    return bounded;
};

/**
 * Recursive strict-prefix single-linkage clustering over `memberIndices`.
 * `prefixHexes` is the number of 3-hex (12-bit) prefix chunks to require as an
 * exact match before considering a pair. Each recursion doubles the matched
 * prefix, so buckets shrink geometrically; genuinely identical images that
 * survive to the full hash share an exact 64-bit variant.
 */
const reclusterByPrefix = (
    memberIndices: number[],
    indexed: Array<{ fileId: number; entry: PhashEntry }>,
    threshold: number,
    prefixHexes: number,
): number[][] => {
    const tightThreshold = Math.max(2, Math.floor(threshold / 2));
    const prefixLength = prefixHexes * 3;
    const clusterUf = new UnionFind(memberIndices.length);

    const buckets = new Map<string, number[]>();
    for (let i = 0; i < memberIndices.length; i++) {
        const seen = new Set<string>();
        for (const hash of indexed[memberIndices[i]!]!.entry.hashes) {
            const key = hash.slice(0, prefixLength);
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

    for (const indices of buckets.values()) {
        for (let i = 0; i < indices.length; i++) {
            for (let j = i + 1; j < indices.length; j++) {
                const a = indexed[memberIndices[indices[i]!]!]!.entry;
                const b = indexed[memberIndices[indices[j]!]!]!.entry;
                if (variantDistance(a.hashes, b.hashes) <= tightThreshold) {
                    clusterUf.union(indices[i]!, indices[j]!);
                }
            }
        }
    }

    const clusters = new Map<number, number[]>();
    for (let i = 0; i < memberIndices.length; i++) {
        const root = clusterUf.find(i);
        const members = clusters.get(root);
        if (members) {
            members.push(memberIndices[i]!);
        } else {
            clusters.set(root, [memberIndices[i]!]);
        }
    }

    const result: number[][] = [];
    const stillOversized: number[] = [];
    for (const cluster of clusters.values()) {
        if (cluster.length > MAX_GROUP_SIZE) {
            stillOversized.push(...cluster);
        } else {
            result.push(cluster);
        }
    }
    if (stillOversized.length === 0) {
        return result;
    }
    const deeper = reclusterByPrefix(
        stillOversized,
        indexed,
        threshold,
        prefixHexes + 1,
    );
    return [...result, ...deeper];
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
    /** How many crop checks to run per batch before yielding to the event loop. */
    batchSize?: number;
    /** Abort in-flight crop verification (e.g. user left the Similar section). */
    signal?: AbortSignal;
}

/**
 * Stage-2: refine the Stage-1 groups by linking cross-group (or singleton)
 * pairs that are the same photo under a crop. Color proposes candidates; the
 * template match — executed on the worker pool, never the UI thread —
 * verifies them. Runs in asynchronous batches to keep the UI responsive.
 *
 * [Note: crop unions are size-capped.] Verified crop edges must not re-chain
 * Stage-1 components into a mega-group: {@link UnionFind.tryUnion} refuses any
 * merge that would exceed {@link MAX_GROUP_SIZE}. Re-applying dHash reclustering
 * here would wrongly split genuine crop-only matches (different dHash prefixes).
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

    // Seed the union-find with the Stage-1 group memberships so crop checks
    // merge groups across what dHash already found.
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

    // Color buckets: coarse prefix, sorted by full color so similar palettes sit
    // adjacent; each file checks at most MAX_CROP_CHECKS_PER_FILE nearest ones.
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
                // Skip pairs already co-grouped, and pairs that can never merge
                // without exceeding the size cap (avoids wasted worker checks).
                if (uf.find(a) === uf.find(b)) {
                    continue;
                }
                if (uf.componentSize(a) + uf.componentSize(b) > MAX_GROUP_SIZE) {
                    continue;
                }
                candidates.push([a, b]);
            }
        }
    }

    // Verify candidate pairs on the worker pool in batches; each verdict is a
    // small postMessage round-trip, so the UI thread only does the unioning.
    for (let start = 0; start < candidates.length; start += batchSize) {
        throwIfAborted();
        const batch = candidates.slice(start, start + batchSize);
        const verdicts = await Promise.all(
            batch.map(([a, b]) => {
                // Re-check size after earlier unions in prior batches may have
                // grown components; skip the worker call when merge is impossible.
                if (uf.find(a) === uf.find(b)) {
                    return Promise.resolve(false);
                }
                if (uf.componentSize(a) + uf.componentSize(b) > MAX_GROUP_SIZE) {
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
            uf.tryUnion(a, b, MAX_GROUP_SIZE);
        });
        // Yield between batches so progress renders and the tab stays alive.
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throwIfAborted();

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
        // Safety net: size-aware unions should already keep components ≤ cap.
        // Hard-slice rather than dHash-recluster so genuine crop links survive.
        if (memberIndices.length > MAX_GROUP_SIZE) {
            for (let i = 0; i < memberIndices.length; i += MAX_GROUP_SIZE) {
                const slice = memberIndices.slice(i, i + MAX_GROUP_SIZE);
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

export const similarityGroupToSelection = (
    group: SimilarityGroup,
    isSelected = false,
): DedupGroupSelection => ({
    id: group.id,
    items: group.items,
    keeperFileId: defaultKeeperFileId(group.items),
    isSelected,
});
