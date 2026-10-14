import { beforeEach, describe, expect, it, vi } from "vitest";
import { ItemVisibility } from "ente-media/file-metadata";
import type { FavoriteOutboxEntry } from "@/lib/favorite-outbox";
import { stubFile } from "@/test-utils/fixtures";

vi.mock("@/db/kv", () => ({
    loadKv: vi.fn(async () => undefined),
    saveKv: vi.fn(async () => undefined),
}));

vi.mock("@/lib/cache-key", () => ({
    getSessionCacheKey: () => "test-cache-key",
}));

vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));

describe("favourite outbox drain batching", () => {
    beforeEach(async () => {
        vi.resetModules();
        const { clearFavoriteOutbox } = await import("@/lib/favorite-outbox");
        const { stopOutboxRunner } = await import("@/lib/outbox-runner");
        clearFavoriteOutbox();
        stopOutboxRunner();
    });

    it("drains many favourites in one remote batch instead of per file", async () => {
        const {
            hydrateFavoriteOutbox,
            upsertFavoriteOutboxEntry,
            getFavoriteOutboxEntries,
        } = await import("@/lib/favorite-outbox");
        const {
            startOutboxRunner,
            flushTagOutboxNow,
            stopOutboxRunner,
        } = await import("@/lib/outbox-runner");

        await hydrateFavoriteOutbox();
        const files = Array.from({ length: 250 }, (_, i) => stubFile({ id: i + 1, collectionID: 10 }));
        for (const file of files) {
            await upsertFavoriteOutboxEntry(file, 1, true);
        }
        expect(getFavoriteOutboxEntries()).toHaveLength(250);

        const applyFavoriteMutations = vi.fn(
            async (entries: FavoriteOutboxEntry[]) => ({
                ackedKeys: entries.map(
                    (entry) => entry.fileHashAndTypeKey ?? String(entry.fileId),
                ),
            }),
        );
        startOutboxRunner({
            getFileById: (fileId: number) =>
                files.find((file) => file.id === fileId),
            getCollections: () => [],
            patchFiles: () => undefined,
            applyFavoriteMutations,
        });

        await flushTagOutboxNow({ notify: false });
        stopOutboxRunner();

        // 250 entries → chunks of 100 → 3 batch calls, zero per-file calls.
        expect(applyFavoriteMutations).toHaveBeenCalledTimes(3);
        expect(applyFavoriteMutations.mock.calls[0]?.[0]).toHaveLength(100);
        expect(applyFavoriteMutations.mock.calls[1]?.[0]).toHaveLength(100);
        expect(applyFavoriteMutations.mock.calls[2]?.[0]).toHaveLength(50);
        expect(getFavoriteOutboxEntries()).toHaveLength(0);
    });

    it("falls back to per-file when a batch throws", async () => {
        const {
            hydrateFavoriteOutbox,
            upsertFavoriteOutboxEntry,
            getFavoriteOutboxEntries,
        } = await import("@/lib/favorite-outbox");
        const {
            startOutboxRunner,
            flushTagOutboxNow,
            stopOutboxRunner,
        } = await import("@/lib/outbox-runner");

        await hydrateFavoriteOutbox();
        await upsertFavoriteOutboxEntry(stubFile({ id: 1, collectionID: 10 }), 1, true);
        await upsertFavoriteOutboxEntry(stubFile({ id: 2, collectionID: 10 }), 1, true);

        const applyFavoriteMutations = vi.fn(
            async (entries: FavoriteOutboxEntry[]) => {
                if (entries.length > 1) {
                    throw new Error("batch failed");
                }
                return { ackedKeys: entries.map((entry) => String(entry.fileId)) };
            },
        );

        startOutboxRunner({
            getFileById: (fileId: number) =>
                [
                    stubFile({ id: 1, collectionID: 10 }),
                    stubFile({ id: 2, collectionID: 10 }),
                ].find((file) => file.id === fileId),
            getCollections: () => [],
            patchFiles: () => undefined,
            applyFavoriteMutations,
        });

        await flushTagOutboxNow({ notify: false });
        stopOutboxRunner();

        // One failed batch of two, then one call per entry.
        expect(applyFavoriteMutations).toHaveBeenCalledTimes(3);
        expect(getFavoriteOutboxEntries()).toHaveLength(0);
    });

    it("keeps a newer favourite intent queued while the older one was in flight", async () => {
        const {
            hydrateFavoriteOutbox,
            upsertFavoriteOutboxEntry,
            getFavoriteOutboxEntries,
        } = await import("@/lib/favorite-outbox");
        const {
            startOutboxRunner,
            flushTagOutboxNow,
            stopOutboxRunner,
        } = await import("@/lib/outbox-runner");

        await hydrateFavoriteOutbox();
        await upsertFavoriteOutboxEntry(stubFile({ id: 1, collectionID: 10 }), 1, true);

        const applyFavoriteMutations = vi.fn(
            async (entries: FavoriteOutboxEntry[]) => {
                if (!entries[0]?.isFavorite) {
                    throw new Error("remote unavailable");
                }
                await upsertFavoriteOutboxEntry(stubFile({ id: 1, collectionID: 10 }), 1, false);
                return {
                    ackedKeys: entries.map((entry) => String(entry.fileId)),
                };
            },
        );

        startOutboxRunner({
            getFileById: (fileId: number) =>
                fileId === 1 ? stubFile({ id: 1, collectionID: 10 }) : undefined,
            getCollections: () => [],
            patchFiles: () => undefined,
            applyFavoriteMutations,
        });

        await flushTagOutboxNow({ notify: false });
        stopOutboxRunner();

        expect(getFavoriteOutboxEntries()).toMatchObject([
            { fileId: 1, isFavorite: false },
        ]);
    });
});

describe("visibility outbox drain", () => {
    beforeEach(async () => {
        vi.resetModules();
        const { clearVisibilityOutbox } = await import(
            "@/lib/visibility-outbox"
        );
        const { stopOutboxRunner } = await import("@/lib/outbox-runner");
        clearVisibilityOutbox();
        stopOutboxRunner();
    });

    it("keeps a newer archive intent queued while the older one was in flight", async () => {
        const {
            hydrateVisibilityOutbox,
            upsertVisibilityOutboxEntry,
            getVisibilityOutboxEntries,
        } = await import("@/lib/visibility-outbox");
        const {
            startOutboxRunner,
            flushTagOutboxNow,
            stopOutboxRunner,
        } = await import("@/lib/outbox-runner");

        await hydrateVisibilityOutbox();
        await upsertVisibilityOutboxEntry(1, ItemVisibility.archived);

        startOutboxRunner({
            getFileById: () => undefined,
            getCollections: () => [],
            patchFiles: () => undefined,
            applyFavoriteMutations: async () => ({ ackedKeys: [] }),
            applyVisibilityMutation: async (entry) => {
                if (entry.visibility !== ItemVisibility.archived) {
                    throw new Error("remote unavailable");
                }
                await upsertVisibilityOutboxEntry(1, ItemVisibility.visible);
            },
        });

        await flushTagOutboxNow({ notify: false });
        stopOutboxRunner();

        expect(getVisibilityOutboxEntries()).toMatchObject([
            { fileId: 1, visibility: ItemVisibility.visible },
        ]);
    });

    it("drains favourites and visibility concurrently", async () => {
        const { hydrateFavoriteOutbox, upsertFavoriteOutboxEntry } =
            await import("@/lib/favorite-outbox");
        const { hydrateVisibilityOutbox, upsertVisibilityOutboxEntry } =
            await import("@/lib/visibility-outbox");
        const { startOutboxRunner, flushTagOutboxNow, stopOutboxRunner } =
            await import("@/lib/outbox-runner");

        await hydrateFavoriteOutbox();
        await hydrateVisibilityOutbox();
        await upsertFavoriteOutboxEntry(stubFile({ id: 1, collectionID: 10 }), 1, true);
        await upsertVisibilityOutboxEntry(2, ItemVisibility.archived);

        let releaseFavorite: () => void = () => undefined;
        let visibilityStarted = false;
        const applyFavoriteMutations = vi.fn(
            (entries: FavoriteOutboxEntry[]) =>
                new Promise<{ ackedKeys: string[] }>((resolve) => {
                    releaseFavorite = () =>
                        resolve({ ackedKeys: entries.map((e) => String(e.fileId)) });
                }),
        );

        startOutboxRunner({
            getFileById: () => undefined,
            getCollections: () => [],
            patchFiles: () => undefined,
            applyFavoriteMutations,
            applyVisibilityMutation: async () => {
                visibilityStarted = true;
                releaseFavorite();
            },
        });

        // Would deadlock if visibility waited for the favourite drain.
        await flushTagOutboxNow({ notify: false });
        stopOutboxRunner();

        expect(visibilityStarted).toBe(true);
    });
});
