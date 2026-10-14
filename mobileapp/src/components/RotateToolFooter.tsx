import { useCallback, useMemo, type JSX } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { mapBatched } from "@/lib/batched";
import {
    confirmDiscardPendingRotations,
    countPendingRotations,
} from "@/lib/rotate-draft";
import { useLibraryStore } from "@/stores/library-store";
import { useSelectionStore } from "@/stores/selection-store";
import { toast } from "sonner";
import { plural } from "@/lib/format";

const APPLY_CONCURRENCY = 3;

/**
 * Footer for quick-rotate mode: draft taps, then Apply uploads a few at a time.
 */
export function RotateToolFooter(): JSX.Element | null {
    const rotateActive = useSelectionStore((s) => s.rotateActive);
    const pendingRotations = useSelectionStore((s) => s.pendingRotations);
    const setRotateActive = useSelectionStore((s) => s.setRotateActive);
    const clearPendingRotations = useSelectionStore(
        (s) => s.clearPendingRotations,
    );
    const removePendingRotation = useSelectionStore(
        (s) => s.removePendingRotation,
    );
    const setRotateBusy = useSelectionStore((s) => s.setRotateBusy);
    const rotateBusy = useSelectionStore((s) => s.rotateBusy);
    const rotateAndUploadFile = useLibraryStore((s) => s.rotateAndUploadFile);

    const pendingCount = useMemo(
        () => countPendingRotations(pendingRotations),
        [pendingRotations],
    );

    const pendingEntries = useMemo(
        () =>
            Object.entries(pendingRotations).map(([id, degrees]) => ({
                fileId: Number(id),
                degrees,
            })),
        [pendingRotations],
    );

    const exitRotate = useCallback((): void => {
        if (rotateBusy) {
            return;
        }
        if (!confirmDiscardPendingRotations(pendingRotations)) {
            return;
        }
        setRotateActive(false);
    }, [pendingRotations, rotateBusy, setRotateActive]);

    const handleDiscard = useCallback((): void => {
        if (rotateBusy) {
            return;
        }
        clearPendingRotations();
    }, [clearPendingRotations, rotateBusy]);

    const handleApply = useCallback(async (): Promise<void> => {
        if (rotateBusy || pendingEntries.length === 0) {
            return;
        }
        setRotateBusy(true);
        const total = pendingEntries.length;
        let done = 0;
        let failed = 0;
        const progress = toast.loading(`Rotating 0 of ${total}…`);
        try {
            // Rotations update files in place and are mostly network-bound,
            // so a few in flight overlap one file's upload with the next download.
            await mapBatched(
                pendingEntries,
                async (entry) => {
                    try {
                        await rotateAndUploadFile(entry.fileId, entry.degrees);
                        removePendingRotation(entry.fileId);
                        done += 1;
                        toast.loading(`Rotating ${done} of ${total}…`, {
                            id: progress,
                        });
                    } catch (error) {
                        failed += 1;
                        console.warn("Quick rotate failed", entry.fileId, error);
                    }
                },
                { concurrency: APPLY_CONCURRENCY },
            );
            if (failed === 0) {
                toast.success(
                    `Rotated ${plural(done, "photo")}`,
                    { id: progress },
                );
                setRotateActive(false);
            } else {
                toast.error(
                    `Rotated ${done}, ${failed} failed — retry remaining`,
                    { id: progress },
                );
            }
        } finally {
            setRotateBusy(false);
        }
    }, [
        pendingEntries,
        removePendingRotation,
        rotateAndUploadFile,
        rotateBusy,
        setRotateActive,
        setRotateBusy,
    ]);

    if (!rotateActive) {
        return null;
    }

    return (
        <footer className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 border-t border-border bg-background/95 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur">
            <div className="flex items-center justify-between gap-2">
                <p className="flex min-w-0 items-center gap-1.5 truncate text-sm text-muted-foreground">
                    <RotateCw className="size-3.5 shrink-0" />
                    <span className="truncate">
                        {pendingCount === 0 ?
                            "Tap photos to rotate +90°" :
                            `${pendingCount} pending · tap to +90°`}
                    </span>
                </p>
                <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={rotateBusy || pendingCount === 0}
                        onClick={handleDiscard}
                    >
                        Discard
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={rotateBusy}
                        onClick={exitRotate}
                    >
                        Close
                    </Button>
                    <Button
                        type="button"
                        variant="default"
                        size="sm"
                        disabled={rotateBusy || pendingCount === 0}
                        onClick={() => {
                            void handleApply();
                        }}
                    >
                        {rotateBusy ? <Spinner className="size-3.5" /> : null}
                        Apply
                    </Button>
                </div>
            </div>
        </footer>
    );
}
