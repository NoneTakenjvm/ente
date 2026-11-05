import { useRef } from "react";
import type { ThumbnailGridSelection } from "@/components/ThumbnailGrid";
import { markReviewYesThrough } from "@/lib/kit-review";
import { buildMediaGridSelection } from "@/lib/selection";
import { useSelectionStore } from "@/stores/selection-store";
import type { EnteFile } from "ente-media/file";

/**
 * Media-grid selection config with stable object identity across toggles when
 * using store-observed checkmarks (see {@link ThumbnailCell} observeStoreSelection).
 *
 * Does not subscribe to `selectedIds` — cells and marquee read the store live —
 * so toggling one photo does not re-render the whole virtualized grid.
 */
export function useMediaGridSelection(
    files?: readonly EnteFile[],
): ThumbnailGridSelection | undefined {
    const mode = useSelectionStore((s) => s.mode);
    const stampTags = useSelectionStore((s) => s.stampTags);
    const reviewKitId = useSelectionStore((s) => s.reviewKitId);
    const cycleReviewMark = useSelectionStore((s) => s.cycleReviewMark);
    const markReviewMany = useSelectionStore((s) => s.markReviewMany);
    const toggleSelection = useSelectionStore((s) => s.toggle);
    const selectMany = useSelectionStore((s) => s.selectMany);
    const bumpRotate = useSelectionStore((s) => s.bumpRotate);
    const addPendingCrop = useSelectionStore((s) => s.addPendingCrop);

    const modeKey = `${mode}|${reviewKitId ?? ""}|${stampTags.join("\0")}`;

    // Read at call time so the cached selection never holds a stale file list.
    const filesRef = useRef(files);
    filesRef.current = files;

    const stableRef = useRef<{
        modeKey: string;
        selection: ThumbnailGridSelection;
    } | null>(null);

    const selectedIds = new Set(useSelectionStore.getState().selectedIds);
    const built = buildMediaGridSelection({
        mode,
        selectedIds,
        stampTags,
        bumpRotate,
        addPendingCrop,
        toggleSelection,
        selectMany,
        reviewKitId,
        cycleReviewMark,
        markReviewMany,
        onLongPress: (file: EnteFile): void => {
            markReviewYesThrough(
                filesRef.current?.map((entry) => entry.id) ?? [],
                file.id,
            );
        },
    });

    if (!built) {
        stableRef.current = null;
        return undefined;
    }

    const withStoreObserve: ThumbnailGridSelection = mode === "select" ?
        { ...built, observeStoreSelection: true } :
        built;

    if (stableRef.current?.modeKey !== modeKey) {
        stableRef.current = { modeKey, selection: withStoreObserve };
        return withStoreObserve;
    }

    const stable = stableRef.current;
    stable.selection.selectedIds = withStoreObserve.selectedIds;
    return stable.selection;
}
