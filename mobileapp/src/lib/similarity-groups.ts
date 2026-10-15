import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import {
    KIT_EMBEDDING_DIMS,
    type ReadonlyEmbeddingMap,
} from "@/lib/kit-embedding";
import {
    collectionNameByID,
    normalOwnedCollections,
} from "@/lib/collections";
import {
    defaultKeeperFileId,
    type DedupGroupItem,
    type DedupGroupSelection,
    type KeeperContext,
} from "@/lib/dedup-prune";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";

export interface SimilarityGroup {
    id: string;
    items: DedupGroupItem[];
}

export const defaultSimilarityThreshold = 12;

/**
 * Files Similar compares: owned, non-archived stills in normal owned
 * collections that have a CLIP vector. One entry per file id.
 */
export const similarCandidateFiles = (
    files: readonly EnteFile[],
    embeddings: ReadonlyEmbeddingMap,
    collections: Collection[],
    userId: number,
): EnteFile[] => {
    const allowedCollectionIDs = new Set(
        normalOwnedCollections(collections, userId).map(
            (collection) => collection.id,
        ),
    );
    const seenIds = new Set<number>();
    const candidates: EnteFile[] = [];
    for (const file of files) {
        if (
            seenIds.has(file.id) ||
            file.ownerID !== userId ||
            file.metadata.fileType !== FileType.image ||
            !allowedCollectionIDs.has(file.collectionID) ||
            isFileArchivedLocally(file) ||
            embeddings.get(file.id)?.length !== KIT_EMBEDDING_DIMS
        ) {
            continue;
        }
        seenIds.add(file.id);
        candidates.push(file);
    }
    return candidates;
};

/**
 * Turn file-id groups into display {@link SimilarityGroup}s, skipping files
 * with no known collection and groups left with fewer than two files.
 */
export const similarityGroupsFromIds = (
    idGroups: readonly number[][],
    filesById: Map<number, EnteFile>,
    collections: Collection[],
    userId: number,
): SimilarityGroup[] => {
    const names = collectionNameByID(
        normalOwnedCollections(collections, userId),
    );
    const groups: SimilarityGroup[] = [];
    for (const fileIds of idGroups) {
        const items = similarityGroupItems(fileIds, filesById, names);
        if (items.length >= 2) {
            groups.push(toSimilarityGroup(items));
        }
    }
    return groups;
};

export const similarityGroupToSelection = (
    group: SimilarityGroup,
    isSelected = false,
    keeperContext?: KeeperContext,
): DedupGroupSelection => ({
    id: group.id,
    items: group.items,
    keeperFileId: defaultKeeperFileId(group.items, keeperContext),
    isSelected,
});

/** Resolve file ids to display items, skipping files with no known collection. */
const similarityGroupItems = (
    fileIds: Iterable<number>,
    filesById: Map<number, EnteFile>,
    names: Map<number, string>,
): DedupGroupItem[] => {
    const items: DedupGroupItem[] = [];
    for (const fileId of fileIds) {
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
    return items;
};

const toSimilarityGroup = (items: DedupGroupItem[]): SimilarityGroup => {
    items.sort((a, b) => a.collectionName.localeCompare(b.collectionName));
    return {
        id: `similar-${items.map((item) => item.file.id).sort((a, b) => a - b).join("-")}`,
        items,
    };
};
