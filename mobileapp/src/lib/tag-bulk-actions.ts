import { toast } from "sonner";
import {
    snapshotTagsForUndo,
    tagDraftHasChanges,
    type TagDraft,
} from "@/lib/tag-bulk";
import {
    addTagNames,
    removeTagNames,
    type TagMutator,
} from "@/lib/tag-writes";
import { useLibraryStore } from "@/stores/library-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";

/**
 * Apply a tag mutator to many files, record undo, and show a toast with Undo.
 */
export const runBulkTagMutation = async (
    fileIds: number[],
    mutator: TagMutator,
    options?: {
        successLabel?: string;
        recordRecent?: string[];
    },
): Promise<{ succeeded: number; failed: number }> => {
    const uniqueIds = [...new Set(fileIds)];
    if (!uniqueIds.length) {
        return { succeeded: 0, failed: 0 };
    }

    const allFiles = useLibraryStore.getState().allFiles;
    const undo = snapshotTagsForUndo(allFiles, uniqueIds);
    useTagSpeedStore.getState().setLastBulkUndo(undo);

    if (options?.recordRecent?.length) {
        useTagSpeedStore.getState().recordRecentTags(options.recordRecent);
    }

    const result = await useLibraryStore
        .getState()
        .batchUpdateTagsOnFiles(uniqueIds, mutator);

    const label =
        options?.successLabel ??
        (uniqueIds.length === 1 ?
            "Updated 1 photo" :
            `Updated ${uniqueIds.length} photos`);

    if (result.failed > 0) {
        toast.error(`Updated ${result.succeeded}, ${result.failed} failed`);
    } else {
        toast.success(label, {
            action: {
                label: "Undo",
                onClick: () => {
                    void undoLastBulkTagMutation();
                },
            },
        });
    }

    return { succeeded: result.succeeded, failed: result.failed };
};

/**
 * Add one or more tags to every file in the set.
 */
export const bulkAddTags = async (
    fileIds: number[],
    tags: string[],
): Promise<{ succeeded: number; failed: number }> => {
    if (!tags.length) {
        return { succeeded: 0, failed: 0 };
    }
    return runBulkTagMutation(
        fileIds,
        (current) => addTagNames(current, ...tags),
        {
            successLabel:
                fileIds.length === 1 ?
                    `Added ${tags.join(", ")}` :
                    `Tagged ${fileIds.length} photos`,
            recordRecent: tags,
        },
    );
};

/**
 * Remove one or more tags from every file in the set.
 */
export const bulkRemoveTags = async (
    fileIds: number[],
    tags: string[],
): Promise<{ succeeded: number; failed: number }> => {
    if (!tags.length) {
        return { succeeded: 0, failed: 0 };
    }
    return runBulkTagMutation(
        fileIds,
        (current) => removeTagNames(current, ...tags),
        {
            successLabel:
                fileIds.length === 1 ?
                    `Removed ${tags.join(", ")}` :
                    `Updated ${fileIds.length} photos`,
            recordRecent: tags,
        },
    );
};

/**
 * Merge source tags onto every file (does not remove existing tags).
 */
export const bulkMergeTags = async (
    fileIds: number[],
    tags: string[],
): Promise<{ succeeded: number; failed: number }> =>
    bulkAddTags(fileIds, tags);

/**
 * Apply a staged selection-sheet draft in one batch write.
 */
export const bulkApplyTagDraft = async (
    fileIds: number[],
    draft: TagDraft,
): Promise<{ succeeded: number; failed: number }> => {
    if (!tagDraftHasChanges(draft)) {
        return { succeeded: 0, failed: 0 };
    }
    return runBulkTagMutation(
        fileIds,
        (current) =>
            removeTagNames(
                addTagNames(current, ...draft.adds),
                ...draft.removes,
            ),
        {
            successLabel:
                fileIds.length === 1 ?
                    "Updated tags" :
                    `Updated tags on ${fileIds.length} photos`,
            recordRecent: draft.adds,
        },
    );
};

/**
 * Restore each file's tags from the last bulk undo snapshot.
 */
export const undoLastBulkTagMutation = async (): Promise<boolean> => {
    const entries = useTagSpeedStore.getState().lastBulkUndo;
    if (!entries?.length) {
        toast.message("Nothing to undo");
        return false;
    }

    useTagSpeedStore.getState().clearLastBulkUndo();

    const library = useLibraryStore.getState();
    let succeeded = 0;
    let failed = 0;
    for (const entry of entries) {
        try {
            await library.updateTagsOnFile(entry.fileId, () => entry.previousTags);
            succeeded += 1;
        } catch {
            failed += 1;
        }
    }

    if (failed > 0) {
        toast.error(`Undid ${succeeded}, ${failed} failed`);
    } else {
        toast.success(
            succeeded === 1 ?
                "Undid tag change" :
                `Undid tags on ${succeeded} photos`,
        );
    }
    return failed === 0;
};
