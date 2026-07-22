import { beforeEach, describe, expect, it, vi } from "vitest";
import { ItemVisibility } from "ente-media/file-metadata";
import type { EnteFile } from "ente-media/file";

vi.mock("@/db/kv", () => ({
    loadEncryptedFavoriteOutbox: vi.fn(async () => undefined),
    saveEncryptedFavoriteOutbox: vi.fn(async () => undefined),
    loadEncryptedVisibilityOutbox: vi.fn(async () => undefined),
    saveEncryptedVisibilityOutbox: vi.fn(async () => undefined),
    loadEncryptedDerivedReplaceOutbox: vi.fn(async () => undefined),
    saveEncryptedDerivedReplaceOutbox: vi.fn(async () => undefined),
}));

const payloadStore = new Map<number, Uint8Array>();

vi.mock("@/db/derived-replace-payloads", () => ({
    putDerivedReplacePayload: vi.fn(async (fileId: number, bytes: Uint8Array) => {
        payloadStore.set(fileId, bytes.slice());
    }),
    getDerivedReplacePayload: vi.fn(async (fileId: number) =>
        payloadStore.get(fileId)?.slice()),
    deleteDerivedReplacePayload: vi.fn(async (fileId: number) => {
        payloadStore.delete(fileId);
    }),
    clearDerivedReplacePayloads: vi.fn(async () => {
        payloadStore.clear();
    }),
}));

vi.mock("@/lib/cache-key", () => ({
    getSessionCacheKey: () => "test-cache-key",
}));

const stubFile = (id: number, ownerID = 1): EnteFile =>
    ({
        id,
        ownerID,
        collectionID: 10,
        key: "key",
        metadata: { fileType: 0 },
    }) as EnteFile;

describe("favorite outbox", () => {
    beforeEach(async () => {
        const { clearFavoriteOutbox } = await import("@/lib/favorite-outbox");
        clearFavoriteOutbox();
    });

    it("upserts and remaps file ids after derived replace", async () => {
        const {
            upsertFavoriteOutboxEntry,
            getFavoriteOutboxEntries,
            remapFavoriteOutboxFileId,
            hydrateFavoriteOutbox,
        } = await import("@/lib/favorite-outbox");

        await hydrateFavoriteOutbox();
        await upsertFavoriteOutboxEntry(stubFile(42), 1, true);
        expect(getFavoriteOutboxEntries()).toHaveLength(1);
        expect(getFavoriteOutboxEntries()[0]?.fileId).toBe(42);

        await remapFavoriteOutboxFileId(42, 99);
        expect(getFavoriteOutboxEntries()[0]?.fileId).toBe(99);
    });
});

describe("visibility outbox", () => {
    beforeEach(async () => {
        const { clearVisibilityOutbox } = await import(
            "@/lib/visibility-outbox"
        );
        clearVisibilityOutbox();
    });

    it("applies pending archive intents locally", async () => {
        const {
            hydrateVisibilityOutbox,
            upsertVisibilityOutboxEntry,
            applyOutboxVisibilityToFiles,
            isFileArchivedLocally,
        } = await import("@/lib/visibility-outbox");

        await hydrateVisibilityOutbox();
        const file = stubFile(7);
        await upsertVisibilityOutboxEntry(7, ItemVisibility.archived);
        const applied = applyOutboxVisibilityToFiles([file]);
        expect(isFileArchivedLocally(applied[0]!)).toBe(true);
    });
});

describe("edit history", () => {
    beforeEach(async () => {
        const { clearAllEditHistory } = await import("@/lib/edit-history");
        clearAllEditHistory();
    });

    it("records and remaps the latest local edit", async () => {
        const {
            recordEditHistory,
            getEditHistory,
            remapEditHistoryFileId,
            hasEditHistory,
            clearEditHistory,
        } = await import("@/lib/edit-history");

        recordEditHistory({
            fileId: 1,
            previousBytes: new Uint8Array([1, 2, 3]),
            width: 10,
            height: 20,
            createdAt: Date.now(),
            kind: "crop",
        });
        expect(hasEditHistory(1)).toBe(true);
        remapEditHistoryFileId(1, 5);
        expect(hasEditHistory(1)).toBe(false);
        expect(getEditHistory(5)?.previousFileId).toBe(1);
        clearEditHistory(5);
        expect(hasEditHistory(5)).toBe(false);
    });
});

describe("derived replace outbox", () => {
    beforeEach(async () => {
        payloadStore.clear();
        const { clearDerivedReplaceOutbox } = await import(
            "@/lib/derived-replace-outbox"
        );
        clearDerivedReplaceOutbox();
    });

    it("stores payload bytes separately from outbox metadata", async () => {
        const {
            hydrateDerivedReplaceOutbox,
            upsertDerivedReplaceOutboxEntry,
            getDerivedReplaceOutboxEntries,
            loadDerivedReplaceOutboxBytes,
        } = await import("@/lib/derived-replace-outbox");

        await hydrateDerivedReplaceOutbox();
        const bytes = new Uint8Array([9, 8, 7, 6]);
        await upsertDerivedReplaceOutboxEntry(3, bytes, 100, 80, "auto-crop");
        const entry = getDerivedReplaceOutboxEntries()[0]!;
        expect(entry.width).toBe(100);
        expect(entry.kind).toBe("auto-crop");
        expect([...(await loadDerivedReplaceOutboxBytes(3))!]).toEqual([
            9, 8, 7, 6,
        ]);
    });
});
