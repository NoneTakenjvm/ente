import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cache-key", () => ({ hasSessionCacheKey: () => true }));

import { runSessionResets } from "@/lib/session-lifecycle";
import { createIndexStore } from "../create-index-store";

describe("createIndexStore", () => {
    it("loads once for concurrent ensureHydrated calls", async () => {
        const load = vi.fn(async () => new Map([[1, 5]]));
        const store = createIndexStore<Map<number, number>>(
            () => new Map(),
            load,
        );
        await Promise.all([
            store.getState().ensureHydrated(),
            store.getState().ensureHydrated(),
        ]);
        await store.getState().ensureHydrated();
        expect(load).toHaveBeenCalledTimes(1);
        expect(store.getState().isHydrated).toBe(true);
        expect(store.getState().entries.get(1)).toBe(5);
    });

    it("clears on session reset and reloads afterwards", async () => {
        const load = vi.fn(async () => new Map([[1, 5]]));
        const store = createIndexStore<Map<number, number>>(
            () => new Map(),
            load,
        );
        await store.getState().ensureHydrated();
        runSessionResets();
        expect(store.getState().isHydrated).toBe(false);
        expect(store.getState().entries.size).toBe(0);
        await store.getState().ensureHydrated();
        expect(load).toHaveBeenCalledTimes(2);
    });
});
