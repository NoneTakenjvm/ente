import { useCallback, type JSX, type ReactNode } from "react";
import { ToolFooter } from "@/components/ToolFooter";
import { Button } from "@/components/ui/button";
import {
    startBatchApply,
    type BatchApplyRun,
    type BatchApplyVerb,
} from "@/stores/batch-apply-store";
import { useSelectionStore, type SelectionMode } from "@/stores/selection-store";

interface PendingBatchFooterProps<Entry extends { fileId: number }> {
    /** The tool mode this footer belongs to; renders nothing otherwise. */
    mode: Extract<SelectionMode, "rotate" | "crop">;
    icon: ReactNode;
    /** Hint shown when nothing is pending. */
    emptyHint: string;
    /** Hint suffix shown after the pending count, e.g. `drag to adjust`. */
    pendingHint: string;
    verb: BatchApplyVerb;
    entries: Entry[];
    applyOne: BatchApplyRun<Entry>["applyOne"];
    concurrency: number;
    /** Returns false when the user declines to lose the pending drafts. */
    confirmDiscard: () => boolean;
    clearPending: () => void;
}

/**
 * Footer for draft-then-apply tools (crop, rotate): "N pending", Discard,
 * Close, and Apply, which hands the drafts to a background batch (see
 * {@link startBatchApply}) and closes the tool so the UI stays usable.
 */
export function PendingBatchFooter<Entry extends { fileId: number }>({
    mode,
    icon,
    emptyHint,
    pendingHint,
    verb,
    entries,
    applyOne,
    concurrency,
    confirmDiscard,
    clearPending,
}: PendingBatchFooterProps<Entry>): JSX.Element | null {
    const active = useSelectionStore((s) => s.mode === mode);
    const setMode = useSelectionStore((s) => s.setMode);

    const pendingCount = entries.length;

    const handleClose = useCallback((): void => {
        if (!confirmDiscard()) {
            return;
        }
        setMode("none");
    }, [confirmDiscard, setMode]);

    const handleApply = useCallback((): void => {
        if (entries.length === 0) {
            return;
        }
        startBatchApply({ verb, entries, applyOne, concurrency });
        setMode("none");
    }, [applyOne, concurrency, entries, setMode, verb]);

    if (!active) {
        return null;
    }

    return (
        <ToolFooter
            icon={icon}
            title={
                pendingCount === 0 ?
                    emptyHint :
                    `${pendingCount} pending · ${pendingHint}`
            }
            actions={
                <>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pendingCount === 0}
                        onClick={clearPending}
                    >
                        Discard
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleClose}
                    >
                        Close
                    </Button>
                    <Button
                        type="button"
                        variant="default"
                        size="sm"
                        disabled={pendingCount === 0}
                        onClick={handleApply}
                    >
                        Apply
                    </Button>
                </>
            }
        />
    );
}
