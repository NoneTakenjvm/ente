import type { ThumbnailGridSelection } from "@/components/ThumbnailGrid";
import { canCrop } from "@/lib/crop";
import { bulkAddTags } from "@/lib/tag-bulk-actions";
import type { EnteFile } from "ente-media/file";
import { toast } from "sonner";

/**
 * Bottom pad for select/stamp/rotate footers while the AppShell nav is hidden.
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
    toggleSelection: (fileId: number) => void;
    selectMany: (fileIds: number[], mode: "add" | "toggle") => void;
    disabled?: boolean;
}

/**
 * Grid tap/drag behaviour for selection, stamp, or quick-rotate tools.
 * Stamp applies tags only (no checkmarks); rotate drafts +90° (tap only).
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
            onSelectMany: (fileIds: number[]): void => {
                if (tags.length === 0 || fileIds.length === 0) {
                    return;
                }
                void bulkAddTags(fileIds, tags);
            },
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
    };
}
