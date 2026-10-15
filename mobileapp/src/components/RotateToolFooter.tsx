import { useCallback, useMemo, type JSX } from "react";
import { RotateCw } from "lucide-react";
import { PendingBatchFooter } from "@/components/PendingBatchFooter";
import type { RotationDegrees } from "@/lib/rotate";
import { confirmDiscardPendingRotations } from "@/lib/rotate-draft";
import { useLibraryStore } from "@/stores/library-store";
import { useSelectionStore } from "@/stores/selection-store";

const APPLY_CONCURRENCY = 3;
const VERB = { active: "Rotating", past: "Rotated" };

interface PendingRotation {
    fileId: number;
    degrees: RotationDegrees;
}

/**
 * Footer for quick-rotate mode: draft taps, then Apply uploads a few at a time.
 * Rotations update files in place and are mostly network-bound, so a few in
 * flight overlap one file's upload with the next download.
 */
export function RotateToolFooter(): JSX.Element | null {
    const pendingRotations = useSelectionStore((s) => s.pendingRotations);
    const clearPendingRotations = useSelectionStore(
        (s) => s.clearPendingRotations,
    );
    const rotateAndUploadFile = useLibraryStore((s) => s.rotateAndUploadFile);

    const entries = useMemo(
        (): PendingRotation[] =>
            Object.entries(pendingRotations).map(([id, degrees]) => ({
                fileId: Number(id),
                degrees,
            })),
        [pendingRotations],
    );

    const applyOne = useCallback(
        async (entry: PendingRotation): Promise<void> => {
            await rotateAndUploadFile(entry.fileId, entry.degrees);
        },
        [rotateAndUploadFile],
    );

    const confirmDiscard = useCallback(
        (): boolean => confirmDiscardPendingRotations(pendingRotations),
        [pendingRotations],
    );

    return (
        <PendingBatchFooter
            mode="rotate"
            icon={<RotateCw className="size-3.5 shrink-0" />}
            emptyHint="Tap photos to rotate +90°"
            pendingHint="tap to +90°"
            verb={VERB}
            entries={entries}
            applyOne={applyOne}
            concurrency={APPLY_CONCURRENCY}
            confirmDiscard={confirmDiscard}
            clearPending={clearPendingRotations}
        />
    );
}
