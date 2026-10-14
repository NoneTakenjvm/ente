import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const stores = new Map<string, Map<unknown, Row>>();
const keyField: Record<string, string> = {
    kv: "key",
    phashChunks: "chunkId",
    embeddingChunks: "chunkId",
};

const storeFor = (name: string): Map<unknown, Row> => {
    let store = stores.get(name);
    if (!store) {
        store = new Map();
        stores.set(name, store);
    }
    return store;
};

vi.mock("@/db/index", () => ({
    getOrganizerDB: async () => ({
        get: async (name: string, key: unknown) => storeFor(name).get(key),
        put: async (name: string, row: Row) => {
            storeFor(name).set(row[keyField[name]!], row);
        },
        getAll: async (name: string) =>
            [...storeFor(name).entries()]
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([, row]) => row),
        clear: async (name: string) => {
            storeFor(name).clear();
        },
    }),
}));

vi.mock("@/lib/cache-key", () => ({
    getSessionCacheKey: () => "session-key",
}));

// Stand-in cipher: the stored string records which key encrypted it.
vi.mock("@/db/crypto", () => ({
    encryptCachePayload: async (data: unknown, cacheKey: string) => ({
        encryptedData: `${cacheKey}|${JSON.stringify(data)}`,
        decryptionHeader: "header",
    }),
    decryptCachePayload: async (
        payload: { encryptedData: string },
        cacheKey: string,
    ) => {
        const separator = payload.encryptedData.indexOf("|");
        if (payload.encryptedData.slice(0, separator) !== cacheKey) {
            throw new Error("wrong key");
        }
        return JSON.parse(payload.encryptedData.slice(separator + 1));
    },
}));

const kv = await import("@/db/kv");

beforeEach(() => {
    stores.clear();
});

describe("loadKv / saveKv", () => {
    it("round-trips through encrypted storage with the session key", async () => {
        expect(await kv.loadKv("tagOutbox")).toBeUndefined();
        const entries = [{ fileId: 1, intendedTags: ["a"], enqueuedAt: 5 }];
        await kv.saveKv("tagOutbox", entries);
        expect(await kv.loadKv("tagOutbox")).toEqual(entries);
        const stored = stores.get("kv")?.get("tagOutbox");
        expect(String(stored?.encryptedData).startsWith("session-key|")).toBe(
            true,
        );
    });

    it("uses an explicit cache key when given", async () => {
        await kv.saveKv("favoriteMembership", [1, 2], "other-key");
        await expect(kv.loadKv("favoriteMembership")).rejects.toThrow(
            "wrong key",
        );
        expect(await kv.loadKv("favoriteMembership", "other-key")).toEqual([
            1, 2,
        ]);
    });
});

describe("phash chunks", () => {
    const entry = (hash: string) => ({ hash }) as never;

    it("applies later chunks and removals over earlier ones", async () => {
        await kv.appendPhashChunk(
            new Map([
                [1, entry("a")],
                [2, entry("b")],
            ]),
            "k",
        );
        await kv.appendPhashChunk(
            new Map([
                [1, entry("a2")],
                [2, null],
            ]),
            "k",
        );
        expect((await kv.loadPhashMeta("k"))?.nextChunkId).toBe(2);
        expect(await kv.loadAllPhashChunks("k")).toEqual(
            new Map([[1, entry("a2")]]),
        );
        await kv.clearPhashChunks("k");
        expect((await kv.loadAllPhashChunks("k")).size).toBe(0);
        expect((await kv.loadPhashMeta("k"))?.nextChunkId).toBe(0);
    });
});

describe("embedding chunks", () => {
    const meta = { version: 2 as const, modelId: "m", dims: 2, nextChunkId: 0 };

    it("appends in order, advances meta, and filters by model", async () => {
        let current = await kv.appendEmbeddingChunk(
            new Map([[1, [1, 2]]]),
            meta,
            "k",
        );
        current = await kv.appendEmbeddingChunk(
            new Map<number, ArrayLike<number>>([
                [1, new Float32Array([3, 4])],
                [2, [5, 6]],
            ]),
            current,
            "k",
        );
        expect(current.nextChunkId).toBe(2);
        expect(await kv.appendEmbeddingChunk(new Map(), current, "k")).toBe(
            current,
        );
        const loaded = await kv.loadAllEmbeddingChunks(current, "k");
        expect([...loaded.entries()].map(([id, v]) => [id, [...v]])).toEqual([
            [1, [3, 4]],
            [2, [5, 6]],
        ]);
        const otherModel = { ...current, modelId: "other" };
        expect((await kv.loadAllEmbeddingChunks(otherModel, "k")).size).toBe(0);
        expect(stores.get("embeddingChunks")?.get(0)).toMatchObject({
            chunkId: 0,
            modelId: "m",
            dims: 2,
        });
    });
});
