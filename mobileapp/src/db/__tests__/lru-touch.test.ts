import { describe, expect, it, vi } from "vitest";
import { LruTouchCoalescer } from "@/db/lru-touch";

describe("LruTouchCoalescer", () => {
    it("batches writes until flushEvery and overlays pending times", async () => {
        const batches: Array<Array<[number, number]>> = [];
        const coalescer = new LruTouchCoalescer(async (batch) => {
            batches.push([...batch]);
        });

        coalescer.note(1, 100);
        coalescer.note(2, 200);
        expect(coalescer.overlay(1, 50)).toBe(100);
        expect(coalescer.overlay(3, 50)).toBe(50);
        expect(batches).toHaveLength(0);

        await coalescer.flush();
        expect(batches).toEqual([
            [
                [1, 100],
                [2, 200],
            ],
        ]);
        expect(coalescer.hasPending).toBe(false);
    });

    it("re-queues a failed batch", async () => {
        let failOnce = true;
        const coalescer = new LruTouchCoalescer(async () => {
            if (failOnce) {
                failOnce = false;
                throw new Error("idb busy");
            }
        });
        coalescer.note(7, 1);
        await coalescer.flush();
        expect(coalescer.hasPending).toBe(true);
        expect(coalescer.overlay(7, 0)).toBe(1);
        await coalescer.flush();
        expect(coalescer.hasPending).toBe(false);
    });

    it("auto-flushes after 32 distinct ids as one batch", async () => {
        const write = vi.fn(async (_batch: ReadonlyMap<number, number>) => undefined);
        const coalescer = new LruTouchCoalescer(write);
        for (let id = 0; id < 32; id += 1) {
            coalescer.note(id, id);
        }
        await vi.waitFor(() => {
            expect(write).toHaveBeenCalledTimes(1);
        });
        expect(write.mock.calls[0]![0].size).toBe(32);
        await coalescer.flush();
        expect(write).toHaveBeenCalledTimes(1);
    });
});
