import { toast } from "sonner";
import { errorMessage } from "@/lib/format";
import { eligibleImageFiles } from "@/lib/job-utils";
import {
    runKitEmbeddingJob,
    type ReadonlyEmbeddingMap,
} from "@/lib/kit-embedding";
import { bulkAddTags } from "@/lib/tag-bulk-actions";
import { nearnessFilterFromKitTags, type TagPreset } from "@/lib/tag-presets";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import {
    useSelectionStore,
    type KitReviewMark,
} from "@/stores/selection-store";
import { useSessionStore } from "@/stores/session-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useUIStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";

/**
 * Ask before dropping staged review marks. Returns true when it is safe to continue.
 */
export const confirmDiscardReviewMarks = (): boolean => {
    const count = useSelectionStore.getState().reviewMarks.size;
    if (count === 0) {
        return true;
    }
    return window.confirm(
        count === 1 ? "Discard 1 review mark?" : `Discard ${count} review marks?`,
    );
};

/**
 * Open the kit review tool for `preset`: rank the grid by kit likeness and hide
 * photos already reviewed. Asks first when switching kits would drop marks;
 * picking the kit already under review keeps its marks.
 */
export const startKitReview = (preset: TagPreset): void => {
    const selection = useSelectionStore.getState();
    const sameKit =
        selection.mode === "kitReview" && selection.reviewKitId === preset.id;
    if (!sameKit && !confirmDiscardReviewMarks()) {
        return;
    }
    useUIStore.getState().setOrdering({
        kind: "nearness",
        filter: nearnessFilterFromKitTags(preset.tags, preset),
        source: "kit",
    });
    if (sameKit) {
        return;
    }
    selection.setMode("kitReview");
    selection.setReviewKitId(preset.id);
};

/**
 * Apply staged review marks: "yes" photos get the kit's tags, "no" photos are
 * remembered as rejections for this kit, then nearness is re-ranked from the
 * top.
 *
 * Marks are taken and cleared before the write is awaited, so a second tap
 * cannot apply them twice and marks made meanwhile are kept.
 */
export const applyKitReview = async (): Promise<void> => {
    const selection = useSelectionStore.getState();
    const kit = useTagSpeedStore
        .getState()
        .presets.find((preset) => preset.id === selection.reviewKitId);
    if (!kit || selection.reviewMarks.size === 0) {
        return;
    }
    const yesIds: number[] = [];
    const noIds: number[] = [];
    for (const [fileId, mark] of selection.reviewMarks) {
        if (mark === "yes") {
            yesIds.push(fileId);
        } else {
            noIds.push(fileId);
        }
    }
    selection.clearReviewMarks();
    const ui = useUIStore.getState();
    ui.addKitReviewRejections(kit.id, noIds);
    // bulkAddTags updates the library before its first await, so the re-rank
    // below already sees the new tags as seeds.
    const write = yesIds.length > 0 ?
        bulkAddTags(yesIds, kit.tags) :
        undefined;
    ui.reapplyNearness();
    ui.scrollGalleryToTop();
    if (write) {
        try {
            await write;
        } catch (error) {
            // Re-stage the yes photos so the user can retry without re-marking.
            useSelectionStore.getState().markReviewMany(yesIds, "yes");
            toast.error(errorMessage(error, "Could not tag photos"));
        }
    } else {
        toast.success(
            `Skipped ${noIds.length} photo${noIds.length === 1 ? "" : "s"}`,
        );
    }
};

/**
 * Leave the kit review tool. Returns false when the user keeps reviewing.
 */
export const exitKitReview = (): boolean => {
    if (!confirmDiscardReviewMarks()) {
        return false;
    }
    const selection = useSelectionStore.getState();
    const { ordering, setOrdering } = useUIStore.getState();
    selection.setMode("none");
    selection.setReviewKitId(undefined);
    if (ordering?.kind === "nearness" && ordering.source === "kit") {
        setOrdering(undefined);
    }
    return true;
};

/**
 * Stage "yes" for every unmarked photo from the top of `orderedIds` down to and
 * including `fileId` (hold on a tile). Shows a toast with Undo, since one hold
 * can mark hundreds of photos.
 */
export const markReviewYesThrough = (
    orderedIds: readonly number[],
    fileId: number,
): void => {
    const index = orderedIds.indexOf(fileId);
    if (index === -1) {
        return;
    }
    markReviewWithUndo(orderedIds.slice(0, index + 1), "yes");
};

/**
 * Stage "no" for every unmarked photo above the lowest marked one: after
 * tapping the yes photos on a screen, this rejects the rest of it.
 */
export const markRestReviewNo = (orderedIds: readonly number[]): void => {
    const { reviewMarks } = useSelectionStore.getState();
    let lastMarkedIndex = -1;
    orderedIds.forEach((id, index) => {
        if (reviewMarks.has(id)) {
            lastMarkedIndex = index;
        }
    });
    markReviewWithUndo(orderedIds.slice(0, lastMarkedIndex + 1), "no");
};

/**
 * Count owned images in `files` that have no CLIP embedding in `embeddings`.
 */
export const countUnembeddedImages = (
    files: readonly EnteFile[],
    embeddings: ReadonlyEmbeddingMap,
): number => unembeddedImages(files, embeddings).length;

/**
 * Embed the unembedded images in `files` behind a progress toast, then re-rank
 * nearness with the new vectors.
 */
export const embedKitReviewCandidates = async (
    files: readonly EnteFile[],
): Promise<void> => {
    const userId = useSessionStore.getState().userID ?? 0;
    const existing = useEmbeddingIndexStore.getState().entries;
    const missing = unembeddedImages(files, existing);
    if (missing.length === 0) {
        return;
    }
    const toastId = toast.loading(`Scanning 0 / ${missing.length}…`);
    try {
        const entries = await runKitEmbeddingJob({
            files: missing,
            userId,
            existing: new Map(existing),
            onProgress: ({ phase, completed, total }) => {
                if (phase === "embed") {
                    toast.loading(`Scanning ${completed} / ${total}…`, {
                        id: toastId,
                    });
                }
            },
        });
        useEmbeddingIndexStore.getState().setEntries(entries);
        toast.dismiss(toastId);
        useUIStore.getState().reapplyNearness();
    } catch (error) {
        toast.error(errorMessage(error, "Could not scan photos"), {
            id: toastId,
        });
    }
};

/**
 * Mark every unmarked id with `mark` and toast the count with an Undo (bulk
 * marks: hold, Rest no, the match cutoff).
 */
export const markReviewWithUndo = (fileIds: readonly number[], mark: KitReviewMark): void => {
    const { reviewMarks: previous, reviewKitId } = useSelectionStore.getState();
    const unmarked = fileIds.filter((id) => !previous.has(id));
    if (unmarked.length === 0) {
        return;
    }
    useSelectionStore.getState().markReviewMany(unmarked, mark);
    navigator.vibrate?.(15);
    toast.message(`Marked ${unmarked.length} ${mark}`, {
        action: {
            label: "Undo",
            onClick: () => {
                // Only undo marks this action made, on the same kit.
                const current = useSelectionStore.getState();
                if (current.reviewKitId !== reviewKitId) {
                    return;
                }
                current.unmarkReview(
                    unmarked.filter(
                        (id) => current.reviewMarks.get(id) === mark,
                    ),
                );
            },
        },
    });
};

const unembeddedImages = (
    files: readonly EnteFile[],
    embeddings: ReadonlyEmbeddingMap,
): EnteFile[] => {
    const userId = useSessionStore.getState().userID ?? 0;
    return eligibleImageFiles(files, userId).filter(
        (file) => !embeddings.has(file.id),
    );
};
