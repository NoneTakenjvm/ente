import type { ThumbnailGridSelection } from "@/components/ThumbnailGrid";
import { bulkAddTags } from "@/lib/tag-bulk-actions";
import type { EnteFile } from "ente-media/file";
import { toast } from "sonner";

export const SELECTION_FOOTER_INSET_PX = 168;

interface BuildMediaGridSelectionArgs {
    selectionEnabled: boolean;
    selectedIds: number[];
    stampActive: boolean;
    stampTags: string[];
    toggleSelection: (fileId: number) => void;
    selectMany: (fileIds: number[], mode: "add" | "toggle") => void;
}

/**
 * Grid tap/drag behaviour for selection mode or the stamp tool.
 * Stamp applies tags only (no checkmarks); selection toggles as usual.
 */
export function buildMediaGridSelection(
    args: BuildMediaGridSelectionArgs,
): ThumbnailGridSelection | undefined {
    if (args.stampActive) {
        const tags = args.stampTags;
        return {
            selectedIds: new Set(),
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
        onToggle: (file: EnteFile): void => {
            args.toggleSelection(file.id);
        },
        onSelectMany: args.selectMany,
    };
}
