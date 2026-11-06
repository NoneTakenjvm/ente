import { create } from "zustand";
import { registerReset } from "@/lib/session-lifecycle";

/** One photo the pass has moved past: tagged (with its log entry) or skipped. */
type TagHelperStep =
    | { kind: "tagged"; fileId: number; queueIndex: number; logId: number } |
    { kind: "skipped"; fileId: number; queueIndex: number };

/** A tagging action kept in the session log. */
export interface TagHelperLogEntry {
    id: number;
    fileId: number;
    /** Kit name, or "Other tags". */
    label: string;
    /** Tags actually added to the photo, so undo never removes a tag it did not add. */
    tags: string[];
    /** `Date.now()` when the photo was tagged. */
    at: number;
}

/** The step {@link TagHelperState.stepBack} removed, with its log entry for tagged steps. */
export interface TagHelperUndoneStep {
    step: TagHelperStep;
    entry?: TagHelperLogEntry;
}

interface TagHelperState {
    /** File ids to visit in order; undefined until a pass starts. */
    queue: number[] | undefined;
    /** Index in the queue of the next photo to show. */
    position: number;
    /** Photos passed in this pass, oldest first. */
    steps: TagHelperStep[];
    /** Tagging actions this session, newest first. */
    log: TagHelperLogEntry[];
    startQueue: (queue: number[]) => void;
    recordTagged: (
        fileId: number,
        queueIndex: number,
        label: string,
        tags: string[],
    ) => void;
    recordSkipped: (fileId: number, queueIndex: number) => void;
    /** Pop the last step and move back to its photo. */
    stepBack: () => TagHelperUndoneStep | undefined;
    /**
     * Remove a log entry and its step, then show its photo again at the current
     * position. Every step sits before `position`, so their indexes stay valid.
     */
    reopenLogEntry: (logId: number) => TagHelperLogEntry | undefined;
}

/** Log ids only need to be unique within a session. */
let nextLogId = 1;

const initialState: Pick<TagHelperState, "queue" | "position" | "steps" | "log"> = {
    queue: undefined,
    position: 0,
    steps: [],
    log: [],
};

/**
 * Session state for the Tag Helper: the pass queue, the Back history and the
 * tag log. Holds no tag writes; the panel applies and removes tags itself.
 */
export const useTagHelperStore = create<TagHelperState>((set, get) => ({
    ...initialState,

    startQueue: (queue): void => {
        set({ queue, position: 0, steps: [] });
    },

    recordTagged: (fileId, queueIndex, label, tags): void => {
        const logId = nextLogId;
        nextLogId += 1;
        const entry: TagHelperLogEntry = {
            id: logId,
            fileId,
            label,
            tags,
            at: Date.now(),
        };
        const step: TagHelperStep = { kind: "tagged", fileId, queueIndex, logId };
        set((state) => ({
            log: [entry, ...state.log],
            steps: [...state.steps, step],
            position: queueIndex + 1,
        }));
    },

    recordSkipped: (fileId, queueIndex): void => {
        const step: TagHelperStep = { kind: "skipped", fileId, queueIndex };
        set((state) => ({
            steps: [...state.steps, step],
            position: queueIndex + 1,
        }));
    },

    stepBack: (): TagHelperUndoneStep | undefined => {
        const { steps, log } = get();
        const step = steps[steps.length - 1];
        if (!step) {
            return undefined;
        }
        const entry =
            step.kind === "tagged" ?
                log.find((candidate) => candidate.id === step.logId) :
                undefined;
        set({
            steps: steps.slice(0, -1),
            position: step.queueIndex,
            log: entry ?
                log.filter((candidate) => candidate.id !== entry.id) :
                log,
        });
        return { step, entry };
    },

    reopenLogEntry: (logId): TagHelperLogEntry | undefined => {
        const { queue, position, steps, log } = get();
        const entry = log.find((candidate) => candidate.id === logId);
        if (!entry || !queue) {
            return undefined;
        }
        set({
            queue: [
                ...queue.slice(0, position),
                entry.fileId,
                ...queue.slice(position),
            ],
            steps: steps.filter(
                (step) => step.kind !== "tagged" || step.logId !== logId,
            ),
            log: log.filter((candidate) => candidate.id !== logId),
        });
        return entry;
    },
}));

registerReset(() => {
    useTagHelperStore.setState(initialState);
});
