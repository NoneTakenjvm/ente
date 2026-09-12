import { describe, expect, it, vi } from "vitest";
import { LruTouchCoalescer } from "../lru-touch";

describe("LruTouchCoalescer", () => {
    it("batches writes until flushEvery and overlays pending times", async () => {
        const writes: Array<[number, number]> = [];
        const coalescer = new LruTouchCoalescer(async (fileId, lastAccess) => {
            writes.push([fileId, lastAccess]);
        });

        coalescer.note(1, 100);
        coalescer.note(2, 200);
        expect(coalescer.overlay(1, 50)).toBe(100);
        expect(coalescer.overlay(3, 50)).toBe(50);
        expect(writes).toHaveLength(0);

        await coalescer.flush();
        expect(writes).toEqual([
            [1, 100],
            [2, 200],
        ]);
        expect(coalescer.hasPending).toBe(false);
    });

    it("re-queues failed writes", async () => {
        let failOnce = true;
        const coalescer = new LruTouchCoalescer(async (fileId, lastAccess) => {
            if (failOnce && fileId === 7) {
                failOnce = false;
                throw new Error("idb busy");
            }
            void lastAccess;
        });
        coalescer.note(7, 1);
        await coalescer.flush();
        expect(coalescer.hasPending).toBe(true);
        await coalescer.flush();
        expect(coalescer.hasPending).toBe(false);
    });

    it("auto-flushes after 32 distinct ids", async () => {
        const write = vi.fn(async () => undefined);
        const coalescer = new LruTouchCoalescer(write);
        for (let id = 0; id < 32; id += 1) {
            coalescer.note(id, id);
        }
        await vi.waitFor(() => {
            expect(write).toHaveBeenCalled();
        });
        await coalescer.flush();
        expect(write.mock.calls.length).toBeGreaterThanOrEqual(32);
    });
});
