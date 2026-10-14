import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
    fileId: number;
    byteSize: number;
    lastAccess: number;
    payload?: string;
};

const rows = new Map<number, Row>();
let getAllCalls = 0;

const fakeStore = {
    get: async (key: number) => rows.get(key),
    put: async (value: Row) => {
        rows.set(value.fileId, value);
    },
    delete: async (key: number) => {
        rows.delete(key);
    },
    openCursor: async () => {
        const entries = [...rows.values()];
        const at = (index: number): unknown =>
            index < entries.length ?
                { value: entries[index], continue: async () => at(index + 1) } :
                null;
        return at(0);
    },
    getAll: async () => {
        getAllCalls += 1;
        return [...rows.values()];
    },
};

const fakeDB = {
    transaction: () => ({ store: fakeStore, done: Promise.resolve() }),
    get: async (_name: string, key: number) => rows.get(key),
    getKey: async (_name: string, key: number) =>
        rows.has(key) ? key : undefined,
    put: async (_name: string, value: Row) => {
        rows.set(value.fileId, value);
    },
    delete: async (_name: string, key: number) => {
        rows.delete(key);
    },
    clear: async () => {
        rows.clear();
    },
};

vi.mock("@/db/index", () => ({
    hasOrganizerDB: () => true,
    getOrganizerDB: async () => fakeDB,
}));
vi.mock("@/db/crypto", () => ({}));

const { createLruBlobStore } = await import("@/db/blob-store");

const newStore = () =>
    createLruBlobStore<Row>({
        storeName: "thumbnails",
        budgetBytes: 100,
        targetBytes: 60,
        touchMinIntervalMs: 1000,
    });

const seed = (fileId: number, lastAccess: number, byteSize = 20): void => {
    rows.set(fileId, { fileId, byteSize, lastAccess });
};

beforeEach(() => {
    rows.clear();
    getAllCalls = 0;
});

describe("createLruBlobStore", () => {
    it("round-trips a row and reports presence", async () => {
        const store = newStore();
        expect(await store.has(1)).toBe(false);
        expect(await store.put({ fileId: 1, byteSize: 10, payload: "a" })).toBe(
            true,
        );
        expect(await store.has(1)).toBe(true);
        expect((await store.get(1))?.payload).toBe("a");
        expect(await store.get(2)).toBeUndefined();
    });

    it("rejects empty rows", async () => {
        expect(await newStore().put({ fileId: 1, byteSize: 0 })).toBe(false);
    });

    it("evicts least-recently-used rows down to the target", async () => {
        for (const [fileId, lastAccess] of [
            [1, 500],
            [2, 100],
            [3, 300],
            [4, 200],
            [5, 400],
        ] as const) {
            seed(fileId, lastAccess);
        }
        const store = newStore();
        // 100 used + 20 incoming > 100; evict oldest until used + 20 <= 60.
        expect(await store.put({ fileId: 6, byteSize: 20 })).toBe(true);
        expect([...rows.keys()].sort()).toEqual([1, 5, 6]);
        expect(getAllCalls).toBe(0);
    });

    it("prefers pending touch times when ranking eviction", async () => {
        for (const [fileId, lastAccess] of [
            [1, 100],
            [2, 200],
            [3, 300],
            [4, 400],
            [5, 500],
        ] as const) {
            seed(fileId, lastAccess);
        }
        const store = newStore();
        await store.get(1); // reads at "now", so row 1 becomes the newest
        await store.put({ fileId: 6, byteSize: 20 });
        expect(rows.has(1)).toBe(true);
        expect(rows.has(2)).toBe(false);
    });

    it("refuses a row that cannot fit even when empty", async () => {
        expect(await newStore().put({ fileId: 1, byteSize: 101 })).toBe(false);
        expect(rows.size).toBe(0);
    });

    it("tracks cached bytes across delete and clear", async () => {
        const store = newStore();
        await store.put({ fileId: 1, byteSize: 50 });
        await store.put({ fileId: 2, byteSize: 50 });
        await store.delete(1);
        // 50 used: a 50-byte row fits without evicting row 2.
        expect(await store.put({ fileId: 3, byteSize: 50 })).toBe(true);
        expect(rows.has(2)).toBe(true);

        await store.clear();
        expect(rows.size).toBe(0);
        expect(await store.put({ fileId: 4, byteSize: 100 })).toBe(true);
    });

    it("coalesces touches and writes them on flush", async () => {
        const store = newStore();
        seed(1, 0);
        seed(2, 0);
        await store.get(1);
        await store.get(2);
        expect(rows.get(1)!.lastAccess).toBe(0);
        await store.flushTouches();
        expect(rows.get(1)!.lastAccess).toBeGreaterThan(0);
        expect(rows.get(2)!.lastAccess).toBeGreaterThan(0);
    });

    it("skips touching rows accessed recently or when suppressed", async () => {
        const recent = Date.now();
        seed(1, recent);
        await newStore().get(1);
        const suppressed = createLruBlobStore<Row>({
            storeName: "thumbnails",
            budgetBytes: 100,
            targetBytes: 60,
            touchMinIntervalMs: 1000,
            suppressTouch: () => true,
        });
        seed(2, 0);
        await suppressed.get(2);
        await suppressed.flushTouches();
        expect(rows.get(1)!.lastAccess).toBe(recent);
        expect(rows.get(2)!.lastAccess).toBe(0);
    });
});
