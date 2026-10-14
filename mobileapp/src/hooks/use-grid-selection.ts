import { useCallback, useMemo, useState } from "react";
import type { ThumbnailGridSelection } from "@/components/ThumbnailGrid";
import { errorMessage } from "@/lib/format";
import type { EnteFile } from "ente-media/file";

/**
 * Tap-to-select state for a {@link ThumbnailGrid} of `files`, plus a busy
 * wrapper for actions on the selection (disables the grid while it runs and
 * clears the selection when it succeeds).
 */
export const useGridSelection = (
    files: EnteFile[],
): {
    selectedIds: Set<number>;
    selection: ThumbnailGridSelection;
    busy: boolean;
    actionError: string | undefined;
    runBusy: (
        action: () => Promise<void>,
        fallbackMessage: string,
    ) => Promise<void>;
} => {
    const [pickedIds, setPickedIds] = useState<Set<number>>(new Set());
    const [busy, setBusy] = useState<boolean>(false);
    const [actionError, setActionError] = useState<string | undefined>();

    // Ignore picked ids that were removed or synced away.
    const selectedIds = useMemo(() => {
        const visibleIds = new Set(files.map((file) => file.id));
        const visiblePicks = new Set(
            [...pickedIds].filter((id) => visibleIds.has(id)),
        );
        return visiblePicks.size === pickedIds.size ? pickedIds : visiblePicks;
    }, [files, pickedIds]);

    const handleToggle = useCallback((file: EnteFile): void => {
        setPickedIds((current) => {
            const next = new Set(current);
            if (next.has(file.id)) {
                next.delete(file.id);
            } else {
                next.add(file.id);
            }
            return next;
        });
    }, []);

    // Stable so the grid's visible cells only re-render when selection changes.
    const selection = useMemo(
        (): ThumbnailGridSelection => ({
            selectedIds,
            onToggle: handleToggle,
            disabled: busy,
        }),
        [busy, handleToggle, selectedIds],
    );

    const runBusy = async (
        action: () => Promise<void>,
        fallbackMessage: string,
    ): Promise<void> => {
        setBusy(true);
        setActionError(undefined);
        try {
            await action();
            setPickedIds(new Set());
        } catch (error) {
            setActionError(errorMessage(error, fallbackMessage));
        } finally {
            setBusy(false);
        }
    };

    return { selectedIds, selection, busy, actionError, runBusy };
};
