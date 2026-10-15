import { toast } from "sonner";
import { create } from "zustand";
import { mapBatched } from "@/lib/batched";
import { plural } from "@/lib/format";
import { registerReset } from "@/lib/session-lifecycle";

/** Progress and result wording: `Cropping` / `Cropped`. */
export interface BatchApplyVerb {
    active: string;
    past: string;
}

export interface BatchApplyRun<Entry extends { fileId: number }> {
    verb: BatchApplyVerb;
    entries: Entry[];
    /**
     * Apply one entry. May return a `finalize` promise (the upload) that the
     * slot waits for before taking the next entry, bounding bytes in memory.
     */
    applyOne: (entry: Entry) => Promise<{ finalize: Promise<unknown> } | void>;
    concurrency: number;
}

/** One running or failed batch, as shown in the banner. */
interface BatchApplyStatus {
    id: number;
    verb: BatchApplyVerb;
    total: number;
    done: number;
    failed: number;
    running: boolean;
    /** Re-run the failed entries; set once a batch ends with failures. */
    retry?: () => void;
}

interface BatchApplyState {
    batches: BatchApplyStatus[];
    dismiss: (id: number) => void;
}

/** Files with an edit still being applied; new drafts on them must wait. */
const applyingFileIds = new Set<number>();
let nextBatchId = 1;

export const useBatchApplyStore = create<BatchApplyState>((set) => ({
    batches: [],
    dismiss: (id: number): void => {
        set((state) => ({
            batches: state.batches.filter((batch) => batch.id !== id),
        }));
    },
}));

/** True while a batch is still applying an edit to this file. */
export const isBatchApplying = (fileId: number): boolean =>
    applyingFileIds.has(fileId);

/**
 * Apply {@link BatchApplyRun.entries} in the background, a few at a time, so
 * the UI stays usable. Progress shows in the batch banner; a clean finish
 * toasts and drops the batch, failures stay in the banner with a retry.
 */
export const startBatchApply = <Entry extends { fileId: number }>(
    run: BatchApplyRun<Entry>,
): void => {
    const { verb, entries, applyOne, concurrency } = run;
    const id = nextBatchId++;
    const failedEntries: Entry[] = [];
    let done = 0;
    const update = (patch?: Partial<BatchApplyStatus>): void => {
        const status: BatchApplyStatus = {
            id,
            verb,
            total: entries.length,
            done,
            failed: failedEntries.length,
            running: true,
            ...patch,
        };
        useBatchApplyStore.setState((state) => ({
            batches: [
                ...state.batches.filter((batch) => batch.id !== id),
                status,
            ],
        }));
    };
    const isLive = (): boolean =>
        useBatchApplyStore.getState().batches.some((batch) => batch.id === id);

    for (const entry of entries) {
        applyingFileIds.add(entry.fileId);
    }
    update();
    void mapBatched(
        entries,
        async (entry) => {
            try {
                // A session reset drops the batch: stop taking entries.
                if (!isLive()) {
                    return;
                }
                const result = await applyOne(entry);
                done += 1;
                update();
                await result?.finalize.catch(() => undefined);
            } catch (error: unknown) {
                failedEntries.push(entry);
                console.warn(`${verb.active} failed`, entry.fileId, error);
                update();
            } finally {
                applyingFileIds.delete(entry.fileId);
            }
        },
        { concurrency },
    ).then(() => {
        if (!isLive()) {
            return;
        }
        if (failedEntries.length === 0) {
            useBatchApplyStore.getState().dismiss(id);
            toast.success(`${verb.past} ${plural(done, "photo")}`);
            return;
        }
        update({
            running: false,
            retry: () => {
                useBatchApplyStore.getState().dismiss(id);
                startBatchApply({ ...run, entries: failedEntries });
            },
        });
    });
};

registerReset(() => {
    useBatchApplyStore.setState({ batches: [] });
});
