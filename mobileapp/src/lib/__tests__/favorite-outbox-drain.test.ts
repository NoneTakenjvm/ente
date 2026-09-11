import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnteFile } from "ente-media/file";
import type { FavoriteOutboxEntry } from "@/lib/favorite-outbox";

vi.mock("@/db/kv", () => ({
    loadEncryptedFavoriteOutbox: vi.fn(async () => undefined),
    saveEncryptedFavoriteOutbox: vi.fn(async () => undefined),
    loadEncryptedTagOutbox: vi.fn(async () => []),
    saveEncryptedTagOutbox: vi.fn(async () => undefined),
    loadEncryptedVisibilityOutbox: vi.fn(async () => undefined),
    saveEncryptedVisibilityOutbox: vi.fn(async () => undefined),
    loadEncryptedDerivedReplaceOutbox: vi.fn(async () => undefined),
    saveEncryptedDerivedReplaceOutbox: vi.fn(async () => undefined),
}));

vi.mock("@/lib/cache-key", () => ({
    getSessionCacheKey: () => "test-cache-key",
}));

vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));

const stubFile = (id: number): EnteFile =>
    ({
        id,
        ownerID: 1,
        collectionID: 10,
        key: "key",
        metadata: { fileType: 0 },
    }) as EnteFile;

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
        const files = Array.from({ length: 250 }, (_, i) => stubFile(i + 1));
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
            getFiles: () => files,
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
        await upsertFavoriteOutboxEntry(stubFile(1), 1, true);
        await upsertFavoriteOutboxEntry(stubFile(2), 1, true);

        const applyFavoriteMutations = vi.fn(async () => {
            throw new Error("batch failed");
        });
        const applyFavoriteMutation = vi.fn(async () => undefined);

        startTagOutboxRunner({
            getFiles: () => [stubFile(1), stubFile(2)],
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
});
