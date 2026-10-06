import type { EnteFile } from "ente-media/file";
import { fileCreationTime } from "ente-media/file-metadata";
import {
    addToCollection,
    type CollectionFilesContext,
} from "@/core/api/collection-files";
import { moveToTrash } from "@/core/api/trash";
import { collectionNameByID } from "@/lib/collections";
import { fileByteSize } from "@/lib/compress";

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

/** User edits to a group's keeper or selection, kept across regroups. */
export type DedupGroupChoice = Partial<
    Pick<DedupGroupSelection, "keeperFileId" | "isSelected">
>;

/** Library signals beyond the file itself that steer the default keeper. */
export interface KeeperContext {
    favoriteFileIds: ReadonlySet<number>;
    /** Image quality in `[0, 1]` by file id (higher = better). */
    qualityById: ReadonlyMap<number, number>;
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

/**
 * Default keeper for a duplicate group. Prefers, in order: a caption, other
 * edits, a favourite, more pixels, a higher quality score, more bytes and the
 * earliest creation time; full ties keep the first item.
 */
export const defaultKeeperFileId = (
    items: DedupGroupItem[],
    context?: KeeperContext,
): number => {
    let keeper = items[0]!.file;
    for (const { file } of items.slice(1)) {
        if (compareKeepers(file, keeper, context) < 0) {
            keeper = file;
        }
    }
    return keeper.id;
};

/** Stable key for a group's membership: its sorted file ids. */
export const dedupGroupMembersKey = (items: readonly DedupGroupItem[]): string =>
    items
        .map((item) => item.file.id)
        .sort((a, b) => a - b)
        .join("-");

/** Negative when `a` makes the better keeper. */
const compareKeepers = (
    a: EnteFile,
    b: EnteFile,
    context: KeeperContext | undefined,
): number => {
    const qualityA = context?.qualityById.get(a.id);
    const qualityB = context?.qualityById.get(b.id);
    return (
        editRank(b) - editRank(a) ||
        Number(context?.favoriteFileIds.has(b.id) ?? false) -
            Number(context?.favoriteFileIds.has(a.id) ?? false) ||
        pixelCount(b) - pixelCount(a) ||
        // Only compare quality when both files have been scored.
        (qualityA !== undefined && qualityB !== undefined ?
            qualityB - qualityA :
            0) ||
        fileByteSize(b) - fileByteSize(a) ||
        fileCreationTime(a) - fileCreationTime(b)
    );
};

const editRank = (file: EnteFile): number => {
    const data = file.pubMagicMetadata?.data;
    if (data?.caption) {
        return 2;
    }
    return data?.editedName ?? data?.editedTime ? 1 : 0;
};

const pixelCount = (file: EnteFile): number => {
    const data = file.pubMagicMetadata?.data;
    return (data?.w ?? 0) * (data?.h ?? 0);
};

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
