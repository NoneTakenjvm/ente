import type { ThumbnailGridSelection } from "@/components/ThumbnailGrid";
import { canCrop } from "@/lib/crop";
import { bulkAddTags } from "@/lib/tag-bulk-actions";
import type { EnteFile } from "ente-media/file";
import { toast } from "sonner";

export const SELECTION_FOOTER_INSET_PX = 168;

interface BuildMediaGridSelectionArgs {
    selectionEnabled: boolean;
    selectedIds: number[];
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
            selectedIds: new Set(),
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
            selectedIds: new Set(),
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
    return {
        selectedIds: new Set(args.selectedIds),
        disabled: args.disabled,
        onToggle: (file: EnteFile): void => {
            args.toggleSelection(file.id);
        },
        onSelectMany: args.selectMany,
    };
}
