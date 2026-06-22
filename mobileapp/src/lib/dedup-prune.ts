import type { EnteFile } from "ente-media/file";
import {
    addToCollection,
    type CollectionFilesContext,
} from "@/core/api/collection-files";
import { moveToTrash } from "@/core/api/trash";
import { collectionNameByID } from "@/lib/collections";

export interface DedupGroupItem {
    file: EnteFile;
    collectionIDs: Set<number>;
    collectionName: string;
}

export interface DedupGroupSelection {
    id: string;
    items: DedupGroupItem[];
    keeperFileId: number;
    isSelected: boolean;
}

export interface PruneDuplicateGroupsOptions {
    ctx: CollectionFilesContext;
    groups: DedupGroupSelection[];
    dryRun?: boolean;
    onProgress?: (progress: number) => void;
}

export interface PruneDuplicateGroupsResult {
    filesToTrash: EnteFile[];
    collectionsToLink: Map<number, EnteFile[]>;
}

const unionCollectionIDs = (
    left: Set<number>,
    right: Set<number>,
): Set<number> => new Set([...left, ...right]);

const differenceCollectionIDs = (
    left: Set<number>,
    right: Set<number>,
): Set<number> => {
    const result = new Set(left);
    for (const id of right) {
        result.delete(id);
    }
    return result;
};

/**
 * Compute which files would be trashed and which collection links would be added.
 */
export const planDuplicateGroupPrune = (
    groups: DedupGroupSelection[],
): PruneDuplicateGroupsResult => {
    const filesToAdd = new Map<number, EnteFile[]>();
    const filesToTrash: EnteFile[] = [];
    const trashedIds = new Set<number>();

    for (const group of groups) {
        if (!group.isSelected) {
            continue;
        }

        const retainedItem = group.items.find(
            (item) => item.file.id === group.keeperFileId,
        );
        if (!retainedItem) {
            continue;
        }

        let collectionIDs = new Set<number>();
        for (const item of group.items) {
            if (item.file.id === retainedItem.file.id) {
                continue;
            }
            collectionIDs = unionCollectionIDs(
                collectionIDs,
                item.collectionIDs,
            );
            if (!trashedIds.has(item.file.id)) {
                trashedIds.add(item.file.id);
                filesToTrash.push(item.file);
            }
        }

        collectionIDs = differenceCollectionIDs(
            collectionIDs,
            retainedItem.collectionIDs,
        );

        for (const collectionID of collectionIDs) {
            filesToAdd.set(collectionID, [
                ...(filesToAdd.get(collectionID) ?? []),
                retainedItem.file,
            ]);
        }
    }

    return { filesToTrash, collectionsToLink: filesToAdd };
};

const duplicateGroupItemToRetain = (
    items: DedupGroupItem[],
): DedupGroupItem => {
    const itemsWithCaption: DedupGroupItem[] = [];
    const itemsWithOtherEdits: DedupGroupItem[] = [];
    for (const item of items) {
        const pubMM = item.file.pubMagicMetadata?.data;
        if (!pubMM) {
            continue;
        }
        if (pubMM.caption) {
            itemsWithCaption.push(item);
        }
        if (pubMM.editedName ?? pubMM.editedTime) {
            itemsWithOtherEdits.push(item);
        }
    }
    return (
        itemsWithCaption[0] ??
        itemsWithOtherEdits[0] ??
        items[0]!
    );
};

/**
 * Default keeper for a duplicate group (caption > edits > first item).
 */
export const defaultKeeperFileId = (items: DedupGroupItem[]): number =>
    duplicateGroupItemToRetain(items).file.id;

/**
 * Symlink keepers into missing albums, then trash losers.
 */
export const pruneDuplicateGroups = async (
    options: PruneDuplicateGroupsOptions,
): Promise<PruneDuplicateGroupsResult> => {
    const selectedGroups = options.groups.filter((group) => group.isSelected);
    const plan = planDuplicateGroupPrune(selectedGroups);

    if (options.dryRun || !plan.filesToTrash.length) {
        options.onProgress?.(100);
        return plan;
    }

    const collectionsByID = collectionNameByID(options.ctx.collections);
    const ctx = options.ctx;

    const steps =
        plan.collectionsToLink.size +
        (plan.filesToTrash.length ? 1 : 0);
    let step = 0;

    for (const [collectionID, files] of plan.collectionsToLink.entries()) {
        const collection = ctx.collections.find((c) => c.id === collectionID);
        if (!collection) {
            throw new Error(
                `Collection ${collectionID} (${collectionsByID.get(collectionID) ?? "unknown"}) not found`,
            );
        }
        await addToCollection(ctx, collection, files);
        step += 1;
        options.onProgress?.((step / steps) * 100);
    }

    if (plan.filesToTrash.length) {
        await moveToTrash(ctx.http, plan.filesToTrash);
        step += 1;
        options.onProgress?.((step / steps) * 100);
    }

    return plan;
};
