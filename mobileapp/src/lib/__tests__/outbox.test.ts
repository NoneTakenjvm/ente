import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Outbox } from "@/lib/outbox";

const kv = vi.hoisted(() => ({
    loadKv: vi.fn(async (_key: string): Promise<unknown> => undefined),
    saveKv: vi.fn(async (_key: string, _value: unknown) => undefined),
}));

vi.mock("@/db/kv", () => kv);

interface TestEntry {
    id: number;
    value: string;
    enqueuedAt: number;
}

const makeOutbox = async (): Promise<Outbox<TestEntry, number>> => {
    const { createOutbox } = await import("@/lib/outbox");
    return createOutbox<TestEntry, number>({
        kvKey: "tagOutbox",
        keyOf: (entry) => entry.id,
        label: "Test outbox",
    });
};

describe("createOutbox", () => {
    beforeEach(() => {
        vi.resetModules();
        kv.loadKv.mockReset().mockResolvedValue(undefined);
        kv.saveKv.mockReset().mockResolvedValue(undefined);
    });

    it("hydrate shares one load between concurrent callers", async () => {
        kv.loadKv.mockResolvedValue([{ id: 1, value: "a", enqueuedAt: 1 }]);
        const outbox = await makeOutbox();

        await Promise.all([outbox.hydrate(), outbox.hydrate()]);
        await outbox.hydrate();

        expect(kv.loadKv).toHaveBeenCalledTimes(1);
        expect(outbox.entries()).toHaveLength(1);
    });

    it("coalesces a burst of upserts into few writes with the final state", async () => {
        const outbox = await makeOutbox();
        await outbox.hydrate();

        await Promise.all(
            [1, 2, 3, 4, 5].map((id) =>
                outbox.upsert([{ id, value: "x", enqueuedAt: id }])),
        );

        expect(kv.saveKv.mock.calls.length).toBeLessThanOrEqual(2);
        const lastWrite = kv.saveKv.mock.calls.at(-1)?.[1] as TestEntry[];
        expect(lastWrite.map((entry) => entry.id).sort()).toEqual([
            1, 2, 3, 4, 5,
        ]);
    });

    it("removeIfUnchanged keeps an entry that was replaced mid-flight", async () => {
        const outbox = await makeOutbox();
        const sent = { id: 1, value: "a", enqueuedAt: 10 };
        await outbox.upsert([sent]);
        await outbox.upsert([{ id: 1, value: "b", enqueuedAt: 11 }]);

        await outbox.removeIfUnchanged([sent]);
        expect(outbox.get(1)?.value).toBe("b");

        await outbox.removeIfUnchanged([{ id: 1, value: "b", enqueuedAt: 11 }]);
        expect(outbox.get(1)).toBeUndefined();
    });

    it("remap moves an entry to the new key", async () => {
        const outbox = await makeOutbox();
        await outbox.upsert([{ id: 1, value: "a", enqueuedAt: 1 }]);

        await outbox.remap(1, 2, (entry) => ({ ...entry, id: 2 }));

        expect(outbox.get(1)).toBeUndefined();
        expect(outbox.get(2)?.id).toBe(2);
    });

    it("flush awaits the in-flight write without writing again", async () => {
        const outbox = await makeOutbox();
        await outbox.hydrate();
        const pending = outbox.upsert([{ id: 1, value: "a", enqueuedAt: 1 }]);
        await outbox.flush();
        await pending;
        await outbox.flush();

        expect(kv.saveKv).toHaveBeenCalledTimes(1);
    });

    it("flush retries once after a failed write", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const outbox = await makeOutbox();
        await outbox.hydrate();
        kv.saveKv.mockRejectedValueOnce(new Error("idb"));
        await outbox.upsert([{ id: 1, value: "a", enqueuedAt: 1 }]);

        await outbox.flush();

        expect(kv.saveKv).toHaveBeenCalledTimes(2);
    });

    it("clear drops memory state and allows a fresh hydrate", async () => {
        const outbox = await makeOutbox();
        await outbox.upsert([{ id: 1, value: "a", enqueuedAt: 1 }]);

        outbox.clear();

        expect(outbox.size()).toBe(0);
        expect(outbox.isHydrated()).toBe(false);
    });
});
