import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cache-key", () => ({ hasSessionCacheKey: () => true }));

import { useTagHelperStore } from "../tag-helper-store";

const resetStore = (): void => {
    useTagHelperStore.setState({
        queue: undefined,
        position: 0,
        steps: [],
        log: [],
    });
};

describe("useTagHelperStore", () => {
    beforeEach(() => {
        resetStore();
    });

    it("startQueue sets the queue and restarts the pass but keeps the log", () => {
        const { startQueue, recordTagged, recordSkipped } =
            useTagHelperStore.getState();
        startQueue([1, 2, 3]);
        recordTagged(1, 0, "Cats", ["cat"]);
        recordSkipped(2, 1);

        startQueue([4, 5]);

        const state = useTagHelperStore.getState();
        expect(state.queue).toEqual([4, 5]);
        expect(state.position).toBe(0);
        expect(state.steps).toEqual([]);
        expect(state.log).toHaveLength(1);
    });

    it("recordSkipped adds a skipped step and moves past it", () => {
        const { startQueue, recordSkipped } = useTagHelperStore.getState();
        startQueue([10, 11, 12]);

        recordSkipped(10, 0);

        const state = useTagHelperStore.getState();
        expect(state.steps).toEqual([
            { kind: "skipped", fileId: 10, queueIndex: 0 },
        ]);
        expect(state.position).toBe(1);
        expect(state.log).toEqual([]);
    });

    it("recordTagged logs newest first and moves past the photo", () => {
        const { startQueue, recordTagged } = useTagHelperStore.getState();
        startQueue([10, 11]);

        recordTagged(10, 0, "Cats", ["cat"]);
        recordTagged(11, 1, "Dogs", ["dog"]);

        const state = useTagHelperStore.getState();
        expect(state.log.map((entry) => entry.label)).toEqual(["Dogs", "Cats"]);
        expect(state.log[1]).toMatchObject({ fileId: 10, tags: ["cat"] });
        expect(state.steps.map((step) => step.kind)).toEqual([
            "tagged",
            "tagged",
        ]);
        expect(state.position).toBe(2);
    });

    it("stepBack returns undefined when there is nothing to undo", () => {
        expect(useTagHelperStore.getState().stepBack()).toBeUndefined();
    });

    it("Back after Skip returns to the skipped photo and leaves the log alone", () => {
        const { startQueue, recordTagged, recordSkipped, stepBack } =
            useTagHelperStore.getState();
        startQueue([10, 11, 12]);
        recordTagged(10, 0, "Cats", ["cat"]);
        recordSkipped(11, 1);

        const undone = stepBack();

        expect(undone).toEqual({
            step: { kind: "skipped", fileId: 11, queueIndex: 1 },
        });
        const state = useTagHelperStore.getState();
        expect(state.position).toBe(1);
        expect(state.log).toHaveLength(1);
    });

    it("Back after a tag drops its log entry and returns the entry for its tags", () => {
        const { startQueue, recordTagged, stepBack } =
            useTagHelperStore.getState();
        startQueue([10, 11]);
        recordTagged(10, 0, "Cats", ["cat"]);

        const undone = stepBack();

        expect(undone?.step.kind).toBe("tagged");
        expect(undone?.entry).toMatchObject({
            fileId: 10,
            label: "Cats",
            tags: ["cat"],
        });
        const state = useTagHelperStore.getState();
        expect(state.log).toEqual([]);
        expect(state.steps).toEqual([]);
        expect(state.position).toBe(0);
    });

    it("Back walks the steps in reverse order", () => {
        const { startQueue, recordSkipped, stepBack } =
            useTagHelperStore.getState();
        startQueue([10, 11, 12]);
        recordSkipped(10, 0);
        recordSkipped(11, 1);

        expect(stepBack()?.step.queueIndex).toBe(1);
        expect(stepBack()?.step.queueIndex).toBe(0);
        expect(stepBack()).toBeUndefined();
        expect(useTagHelperStore.getState().position).toBe(0);
    });

    it("reopenLogEntry shows the photo again and keeps other steps' indexes valid", () => {
        const {
            startQueue,
            recordTagged,
            recordSkipped,
            reopenLogEntry,
            stepBack,
        } = useTagHelperStore.getState();
        startQueue([11, 12, 13, 14, 15]);
        recordTagged(11, 0, "A", ["a"]);
        recordSkipped(12, 1);
        recordTagged(13, 2, "B", ["b"]);
        const logA = useTagHelperStore.getState().log[1]!;
        const logB = useTagHelperStore.getState().log[0]!;

        const reopened = reopenLogEntry(logA.id);

        expect(reopened).toMatchObject({ fileId: 11, label: "A" });
        const state = useTagHelperStore.getState();
        expect(state.queue).toEqual([11, 12, 13, 11, 14, 15]);
        expect(state.position).toBe(3);
        expect(state.steps).toEqual([
            { kind: "skipped", fileId: 12, queueIndex: 1 },
            { kind: "tagged", fileId: 13, queueIndex: 2, logId: logB.id },
        ]);
        expect(state.log.map((entry) => entry.label)).toEqual(["B"]);
        expect(stepBack()?.step.queueIndex).toBe(2);
        expect(stepBack()?.step.queueIndex).toBe(1);
    });

    it("reopenLogEntry ignores unknown ids", () => {
        const { startQueue, reopenLogEntry } = useTagHelperStore.getState();
        startQueue([11]);

        expect(reopenLogEntry(-1)).toBeUndefined();
        expect(useTagHelperStore.getState().queue).toEqual([11]);
    });
});
