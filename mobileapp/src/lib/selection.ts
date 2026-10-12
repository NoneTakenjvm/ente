import type { ThumbnailGridSelection } from "@/components/ThumbnailGrid";
import { getEnteCore } from "@/core";
import { canCrop } from "@/lib/crop";
import { defaultNormalizedCrop, type PendingCrop } from "@/lib/crop-draft";
import { fileAspectRatio } from "@/lib/file-aspect-ratio";
import { bulkAddTags } from "@/lib/tag-bulk-actions";
import { viewportTargetAspectRatio } from "@/lib/viewport-fit";
import { useUIStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";
import { toast } from "sonner";

/**
 * Bottom pad for select/stamp/rotate/crop footers while the AppShell nav is hidden.
 * (~footer chrome; nav is off so no +64 tab bar).
 */
export const SELECTION_FOOTER_INSET_PX = 104;

/** Shared empty set for stamp/rotate — avoids reallocating on every grid rebuild. */
const EMPTY_SELECTED_IDS: ReadonlySet<number> = new Set();

interface BuildMediaGridSelectionArgs {
    selectionEnabled: boolean;
    /** Prefer a memoized Set from the caller so grid `itemData` stays stable across taps. */
    selectedIds: ReadonlySet<number> | readonly number[];
    stampActive: boolean;
    stampTags: string[];
    rotateActive?: boolean;
    bumpRotate?: (fileId: number) => void;
    cropActive?: boolean;
    addPendingCrop?: (fileId: number, crop: PendingCrop) => void;
    toggleSelection: (fileId: number) => void;
    selectMany: (fileIds: number[], mode: "add" | "toggle" | "set") => void;
    disabled?: boolean;
}

/**
 * Grid tap/drag behaviour for selection, stamp, quick-rotate, or quick-crop tools.
 * Stamp applies tags only (no checkmarks); rotate drafts +90° and crop drafts a
 * viewport-aspect box (tap only).
 */
export function buildMediaGridSelection(
    args: BuildMediaGridSelectionArgs,
): ThumbnailGridSelection | undefined {
    if (args.rotateActive) {
        const bump = args.bumpRotate;
        return {
            selectedIds: EMPTY_SELECTED_IDS as Set<number>,
            disabled: args.disabled,
            onToggle: (file: EnteFile): void => {
                if (!canCrop(file)) {
                    toast.message("Rotate works on photos only");
                    return;
                }
                bump?.(file.id);
            },
            // Tap-only: marquee must not bulk-bump rotations.
            onSelectMany: undefined,
        };
    }
    if (args.cropActive) {
        const addPendingCrop = args.addPendingCrop;
        return {
            selectedIds: EMPTY_SELECTED_IDS as Set<number>,
            disabled: args.disabled,
            cropMode: true,
            onToggle: (file: EnteFile, imageAspect?: number): void => {
                if (!canCrop(file)) {
                    toast.message("Crop works on photos only");
                    return;
                }
                if (file.ownerID !== getEnteCore().getUserID()) {
                    toast.message("Can only crop photos you own");
                    return;
                }
                const { viewportTargetWidth, viewportTargetHeight } =
                    useUIStore.getState();
                const aspect = imageAspect ?? fileAspectRatio(file);
                addPendingCrop?.(file.id, {
                    rect: defaultNormalizedCrop(
                        aspect,
                        viewportTargetAspectRatio(
                            viewportTargetWidth,
                            viewportTargetHeight,
                        ),
                    ),
                    imageAspect: aspect,
                });
            },
            // Tap-only: marquee must not bulk-add crop boxes.
            onSelectMany: undefined,
        };
    }
    if (args.stampActive) {
        const tags = args.stampTags;
        return {
            selectedIds: EMPTY_SELECTED_IDS as Set<number>,
            disabled: args.disabled,
            onToggle: (file: EnteFile): void => {
                if (tags.length === 0) {
                    toast.message("Pick tags or a kit first");
                    return;
                }
                void bulkAddTags([file.id], tags);
            },
            // Tap-only: marquee must not bulk-stamp tags.
            onSelectMany: undefined,
        };
    }
    if (!args.selectionEnabled) {
        return undefined;
    }
    const selectedIds =
        args.selectedIds instanceof Set ?
            (args.selectedIds as Set<number>) :
            new Set(args.selectedIds);
    return {
        selectedIds,
        disabled: args.disabled,
        onToggle: (file: EnteFile): void => {
            args.toggleSelection(file.id);
        },
        onSelectMany: args.selectMany,
        onSetSelection: (fileIds: number[]): void => {
            args.selectMany(fileIds, "set");
        },
    };
}
