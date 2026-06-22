import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { metadataHash } from "ente-media/file-metadata";
import {
    collectionNameByID,
    normalOwnedCollections,
} from "@/lib/collections";
import {
    defaultKeeperFileId,
    type DedupGroupItem,
    type DedupGroupSelection,
} from "@/lib/dedup-prune";

export interface ExactDuplicateGroup {
    id: string;
    items: DedupGroupItem[];
    itemSize: number;
    prunableCount: number;
    prunableSize: number;
}

/**
 * Find exact duplicate groups using immutable metadata content hashes.
 */
export const findExactDuplicateGroups = (
    allFiles: EnteFile[],
    collections: Collection[],
    userId: number,
): ExactDuplicateGroup[] => {
    const ownedCollections = normalOwnedCollections(collections, userId);
    const allowedCollectionIDs = new Set(
        ownedCollections.map((collection) => collection.id),
    );
    const names = collectionNameByID(ownedCollections);

    const filesByHash = new Map<string, EnteFile[]>();

    for (const file of allFiles) {
        if (file.ownerID !== userId) {
            continue;
        }
        if (!allowedCollectionIDs.has(file.collectionID)) {
            continue;
        }

        const hash = metadataHash(file.metadata);
        if (!hash) {
            continue;
        }

        filesByHash.set(hash, [...(filesByHash.get(hash) ?? []), file]);
    }

    const duplicateGroups: ExactDuplicateGroup[] = [];

    for (const [hash, duplicates] of filesByHash.entries()) {
        if (duplicates.length < 2) {
            continue;
        }

        let size = 0;
        for (const file of duplicates) {
            if (file.info?.fileSize) {
                size = file.info.fileSize;
                break;
            }
        }
        if (!size) {
            continue;
        }

        const items: DedupGroupItem[] = [];
        for (const file of duplicates) {
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

        items.sort((a, b) =>
            a.collectionName.localeCompare(b.collectionName));

        duplicateGroups.push({
            id: `exact-${hash.slice(0, 16)}`,
            items,
            itemSize: size,
            prunableCount: items.length - 1,
            prunableSize: size * (items.length - 1),
        });
    }

    return duplicateGroups;
};

export const exactGroupToSelection = (
    group: ExactDuplicateGroup,
    isSelected = true,
): DedupGroupSelection => ({
    id: group.id,
    items: group.items,
    keeperFileId: defaultKeeperFileId(group.items),
    isSelected,
});

export const sumPrunableStats = (
    groups: Array<Pick<ExactDuplicateGroup, "prunableCount" | "prunableSize">>,
    selected: boolean[],
): { count: number; size: number } => {
    let count = 0;
    let size = 0;
    for (let i = 0; i < groups.length; i++) {
        if (!selected[i]) {
            continue;
        }
        count += groups[i]!.prunableCount;
        size += groups[i]!.prunableSize;
    }
    return { count, size };
};
