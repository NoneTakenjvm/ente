import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncedPersist } from "@/lib/debounced-persist";

describe("createDebouncedPersist", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("writes only the latest value after the debounce window", async () => {
        const write = vi.fn(async (_value: number) => undefined);
        const saver = createDebouncedPersist(write, 100);

        saver.schedule(1);
        saver.schedule(2);
        await vi.advanceTimersByTimeAsync(99);
        expect(write).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith(2);
    });

    it("flush writes the pending value now and cancels the timer", async () => {
        const write = vi.fn(async (_value: number) => undefined);
        const saver = createDebouncedPersist(write, 100);

        saver.schedule(7);
        await saver.flush();
        expect(write).toHaveBeenCalledWith(7);

        await vi.advanceTimersByTimeAsync(500);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it("flush with nothing pending does not write", async () => {
        const write = vi.fn(async () => undefined);
        await createDebouncedPersist(write, 100).flush();
        expect(write).not.toHaveBeenCalled();
    });

    it("cancel drops the pending value", async () => {
        const write = vi.fn(async () => undefined);
        const saver = createDebouncedPersist(write, 100);

        saver.schedule(1);
        saver.cancel();
        await vi.advanceTimersByTimeAsync(500);
        expect(write).not.toHaveBeenCalled();
    });

    it("keeps writing after a failed write", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const write = vi
            .fn<(value: number) => Promise<void>>()
            .mockRejectedValueOnce(new Error("idb"))
            .mockResolvedValue(undefined);
        const saver = createDebouncedPersist(write, 100);

        saver.schedule(1);
        await vi.advanceTimersByTimeAsync(100);
        saver.schedule(2);
        await saver.flush();

        expect(write).toHaveBeenLastCalledWith(2);
    });
});
