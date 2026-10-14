import { useCallback, type JSX, type ReactNode } from "react";
import { toast } from "sonner";
import { ToolFooter } from "@/components/ToolFooter";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { mapBatched } from "@/lib/batched";
import { plural } from "@/lib/format";
import { useSelectionStore, type SelectionMode } from "@/stores/selection-store";

interface PendingBatchFooterProps<Entry extends { fileId: number }> {
    /** The tool mode this footer belongs to; renders nothing otherwise. */
    mode: Extract<SelectionMode, "rotate" | "crop">;
    icon: ReactNode;
    /** Hint shown when nothing is pending. */
    emptyHint: string;
    /** Hint suffix shown after the pending count, e.g. `drag to adjust`. */
    pendingHint: string;
    /** Progress and result wording: `Cropping` / `Cropped`. */
    verb: { active: string; past: string };
    entries: Entry[];
    /**
     * Apply one entry and drop it from the pending drafts. May return a
     * `finalize` promise to wait for before the next slot starts.
     */
    applyOne: (entry: Entry) => Promise<{ finalize: Promise<unknown> } | void>;
    concurrency: number;
    /** Returns false when the user declines to lose the pending drafts. */
    confirmDiscard: () => boolean;
    clearPending: () => void;
}

/**
 * Footer for draft-then-apply tools (crop, rotate): "N pending", Discard,
 * Close, and Apply, which runs `applyOne` over the entries with a progress toast.
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
    const applyBusy = useSelectionStore((s) => s.applyBusy);
    const setApplyBusy = useSelectionStore((s) => s.setApplyBusy);

    const pendingCount = entries.length;

    const handleClose = useCallback((): void => {
        if (applyBusy || !confirmDiscard()) {
            return;
        }
        setMode("none");
    }, [applyBusy, confirmDiscard, setMode]);

    const handleApply = useCallback(async (): Promise<void> => {
        if (applyBusy || entries.length === 0) {
            return;
        }
        setApplyBusy(true);
        const total = entries.length;
        let done = 0;
        let failed = 0;
        const progress = toast.loading(`${verb.active} 0 of ${total}…`);
        try {
            await mapBatched(
                entries,
                async (entry) => {
                    try {
                        const result = await applyOne(entry);
                        done += 1;
                        toast.loading(`${verb.active} ${done} of ${total}…`, {
                            id: progress,
                        });
                        await result?.finalize.catch(() => undefined);
                    } catch (error) {
                        failed += 1;
                        console.warn(`${verb.active} failed`, entry.fileId, error);
                    }
                },
                { concurrency },
            );
            if (failed === 0) {
                toast.success(`${verb.past} ${plural(done, "photo")}`, {
                    id: progress,
                });
                setMode("none");
            } else {
                toast.error(
                    `${verb.past} ${done}, ${failed} failed — retry remaining`,
                    { id: progress },
                );
            }
        } finally {
            setApplyBusy(false);
        }
    }, [applyBusy, applyOne, concurrency, entries, setApplyBusy, setMode, verb]);

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
                        disabled={applyBusy || pendingCount === 0}
                        onClick={clearPending}
                    >
                        Discard
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={applyBusy}
                        onClick={handleClose}
                    >
                        Close
                    </Button>
                    <Button
                        type="button"
                        variant="default"
                        size="sm"
                        disabled={applyBusy || pendingCount === 0}
                        onClick={() => {
                            void handleApply();
                        }}
                    >
                        {applyBusy ? <Spinner className="size-3.5" /> : null}
                        Apply
                    </Button>
                </>
            }
        />
    );
}
