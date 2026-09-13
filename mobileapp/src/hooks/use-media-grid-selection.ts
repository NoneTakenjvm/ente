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
    const selectionEnabled = useSelectionStore((s) => s.enabled);
    const stampActive = useSelectionStore((s) => s.stampActive);
    const stampTags = useSelectionStore((s) => s.stampTags);
    const rotateActive = useSelectionStore((s) => s.rotateActive);
    const rotateBusy = useSelectionStore((s) => s.rotateBusy);
    const toggleSelection = useSelectionStore((s) => s.toggle);
    const selectMany = useSelectionStore((s) => s.selectMany);
    const bumpRotate = useSelectionStore((s) => s.bumpRotate);

    const disabled = options?.disabled ?? rotateBusy;
    const modeKey = `${selectionEnabled}|${stampActive}|${rotateActive}|${disabled}|${stampTags.join("\0")}`;

    const stableRef = useRef<{
        modeKey: string;
        selection: ThumbnailGridSelection;
    } | null>(null);

    const selectedIds = new Set(useSelectionStore.getState().selectedIds);
    const built = buildMediaGridSelection({
        selectionEnabled,
        selectedIds,
        stampActive,
        stampTags,
        rotateActive,
        bumpRotate,
        toggleSelection,
        selectMany,
        disabled,
    });

    if (!built) {
        stableRef.current = null;
        return undefined;
    }

    const withStoreObserve: ThumbnailGridSelection = selectionEnabled ?
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
