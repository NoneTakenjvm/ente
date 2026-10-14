import { useRef } from "react";
import type { ThumbnailGridSelection } from "@/components/ThumbnailGrid";
import { buildMediaGridSelection } from "@/lib/selection";
import { useSelectionStore } from "@/stores/selection-store";

/**
 * Media-grid selection config with stable object identity across toggles when
 * using store-observed checkmarks (see {@link ThumbnailCell} observeStoreSelection).
 *
 * Does not subscribe to `selectedIds` — cells and marquee read the store live —
 * so toggling one photo does not re-render the whole virtualized grid.
 */
export function useMediaGridSelection(options?: {
    disabled?: boolean;
}): ThumbnailGridSelection | undefined {
    const mode = useSelectionStore((s) => s.mode);
    const stampTags = useSelectionStore((s) => s.stampTags);
    const applyBusy = useSelectionStore((s) => s.applyBusy);
    const toggleSelection = useSelectionStore((s) => s.toggle);
    const selectMany = useSelectionStore((s) => s.selectMany);
    const bumpRotate = useSelectionStore((s) => s.bumpRotate);
    const addPendingCrop = useSelectionStore((s) => s.addPendingCrop);

    const disabled = options?.disabled ?? applyBusy;
    const modeKey = `${mode}|${disabled}|${stampTags.join("\0")}`;

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
        disabled,
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
