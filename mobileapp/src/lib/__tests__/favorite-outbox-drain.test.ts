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
        const { stopTagOutboxRunner } = await import("@/lib/tag-outbox-runner");
        clearFavoriteOutbox();
        stopTagOutboxRunner();
    });

    it("drains many favourites in one remote batch instead of per file", async () => {
        const {
            hydrateFavoriteOutbox,
            upsertFavoriteOutboxEntry,
            getFavoriteOutboxEntries,
        } = await import("@/lib/favorite-outbox");
        const {
            startTagOutboxRunner,
            flushTagOutboxNow,
            stopTagOutboxRunner,
        } = await import("@/lib/tag-outbox-runner");

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
        const applyFavoriteMutation = vi.fn(async () => {
            throw new Error("per-file path should not run on batch success");
        });

        startTagOutboxRunner({
            getFileById: (fileId: number) =>
                files.find((file) => file.id === fileId),
            getCollections: () => [],
            patchFile: async () => undefined,
            applyFavoriteMutations,
            applyFavoriteMutation,
        });

        await flushTagOutboxNow({ notify: false });
        stopTagOutboxRunner();

        // 250 entries → chunks of 100 → 3 batch calls, zero per-file calls.
        expect(applyFavoriteMutations).toHaveBeenCalledTimes(3);
        expect(applyFavoriteMutations.mock.calls[0]?.[0]).toHaveLength(100);
        expect(applyFavoriteMutations.mock.calls[1]?.[0]).toHaveLength(100);
        expect(applyFavoriteMutations.mock.calls[2]?.[0]).toHaveLength(50);
        expect(applyFavoriteMutation).not.toHaveBeenCalled();
        expect(getFavoriteOutboxEntries()).toHaveLength(0);
    });

    it("falls back to per-file when a batch throws", async () => {
        const {
            hydrateFavoriteOutbox,
            upsertFavoriteOutboxEntry,
            getFavoriteOutboxEntries,
        } = await import("@/lib/favorite-outbox");
        const {
            startTagOutboxRunner,
            flushTagOutboxNow,
            stopTagOutboxRunner,
        } = await import("@/lib/tag-outbox-runner");

        await hydrateFavoriteOutbox();
        await upsertFavoriteOutboxEntry(stubFile({ id: 1, collectionID: 10 }), 1, true);
        await upsertFavoriteOutboxEntry(stubFile({ id: 2, collectionID: 10 }), 1, true);

        const applyFavoriteMutations = vi.fn(async () => {
            throw new Error("batch failed");
        });
        const applyFavoriteMutation = vi.fn(async () => undefined);

        startTagOutboxRunner({
            getFileById: (fileId: number) =>
                [
                    stubFile({ id: 1, collectionID: 10 }),
                    stubFile({ id: 2, collectionID: 10 }),
                ].find((file) => file.id === fileId),
            getCollections: () => [],
            patchFile: async () => undefined,
            applyFavoriteMutations,
            applyFavoriteMutation,
        });

        await flushTagOutboxNow({ notify: false });
        stopTagOutboxRunner();

        expect(applyFavoriteMutations).toHaveBeenCalled();
        expect(applyFavoriteMutation).toHaveBeenCalledTimes(2);
        expect(getFavoriteOutboxEntries()).toHaveLength(0);
    });

    it("keeps a newer favourite intent queued while the older one was in flight", async () => {
        const {
            hydrateFavoriteOutbox,
            upsertFavoriteOutboxEntry,
            getFavoriteOutboxEntries,
        } = await import("@/lib/favorite-outbox");
        const {
            startTagOutboxRunner,
            flushTagOutboxNow,
            stopTagOutboxRunner,
        } = await import("@/lib/tag-outbox-runner");

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

        startTagOutboxRunner({
            getFileById: (fileId: number) =>
                fileId === 1 ? stubFile({ id: 1, collectionID: 10 }) : undefined,
            getCollections: () => [],
            patchFile: async () => undefined,
            applyFavoriteMutations,
            applyFavoriteMutation: vi.fn(async () => {
                throw new Error("remote unavailable");
            }),
        });

        await flushTagOutboxNow({ notify: false });
        stopTagOutboxRunner();

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
        const { stopTagOutboxRunner } = await import("@/lib/tag-outbox-runner");
        clearVisibilityOutbox();
        stopTagOutboxRunner();
    });

    it("keeps a newer archive intent queued while the older one was in flight", async () => {
        const {
            hydrateVisibilityOutbox,
            upsertVisibilityOutboxEntry,
            getVisibilityOutboxEntries,
        } = await import("@/lib/visibility-outbox");
        const {
            startTagOutboxRunner,
            flushTagOutboxNow,
            stopTagOutboxRunner,
        } = await import("@/lib/tag-outbox-runner");

        await hydrateVisibilityOutbox();
        await upsertVisibilityOutboxEntry(1, ItemVisibility.archived);

        startTagOutboxRunner({
            getFileById: () => undefined,
            getCollections: () => [],
            patchFile: async () => undefined,
            applyVisibilityMutation: async (entry) => {
                if (entry.visibility !== ItemVisibility.archived) {
                    throw new Error("remote unavailable");
                }
                await upsertVisibilityOutboxEntry(1, ItemVisibility.visible);
            },
        });

        await flushTagOutboxNow({ notify: false });
        stopTagOutboxRunner();

        expect(getVisibilityOutboxEntries()).toMatchObject([
            { fileId: 1, visibility: ItemVisibility.visible },
        ]);
    });
});
