import { describe, expect, it, vi, beforeEach } from "vitest";
import type { EnteFile } from "ente-media/file";
import { fileWithOrganizerTags } from "@/lib/tag-writes";

const saveEncryptedTagOutbox = vi.fn(async () => {});
const loadEncryptedTagOutbox = vi.fn(async () => [] as Array<{
    fileId: number;
    intendedTags: string[];
    enqueuedAt: number;
}>);

vi.mock("@/db/kv", () => ({
    saveEncryptedTagOutbox,
    loadEncryptedTagOutbox,
}));

vi.mock("@/lib/cache-key", () => ({
    getSessionCacheKey: () => "test-cache-key",
}));

const stubFile = (id: number, tags: string[] = []): EnteFile =>
    fileWithOrganizerTags({ id } as EnteFile, tags);

describe("tag-outbox", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const { clearTagOutbox } = await import("@/lib/tag-outbox");
        clearTagOutbox();
    });

    it("upsert replaces an existing entry for the same file", async () => {
        const { upsertTagOutboxEntry, getTagOutboxEntry, hydrateTagOutbox } =
            await import("@/lib/tag-outbox");

        await hydrateTagOutbox();
        await upsertTagOutboxEntry(1, ["a"]);
        await upsertTagOutboxEntry(1, ["a", "b"]);

        expect(getTagOutboxEntry(1)?.intendedTags).toEqual(["a", "b"]);
        expect(saveEncryptedTagOutbox).toHaveBeenCalled();
    });

    it("ensureTagOutboxHydrated does not clear newer in-memory entries", async () => {
        const {
            upsertTagOutboxEntry,
            getTagOutboxEntry,
            hydrateTagOutbox,
            ensureTagOutboxHydrated,
        } = await import("@/lib/tag-outbox");

        await hydrateTagOutbox();
        await upsertTagOutboxEntry(1, ["pending"]);
        loadEncryptedTagOutbox.mockResolvedValueOnce([]);

        await ensureTagOutboxHydrated();

        expect(getTagOutboxEntry(1)?.intendedTags).toEqual(["pending"]);
    });

    it("applyOutboxTagsToFiles overlays pending tags onto files", async () => {
        const { upsertTagOutboxEntry, applyOutboxTagsToFiles, hydrateTagOutbox } =
            await import("@/lib/tag-outbox");

        await hydrateTagOutbox();
        await upsertTagOutboxEntry(2, ["pending"]);

        const files = [
            stubFile(1, ["keep"]),
            stubFile(2, ["old"]),
        ];
        const merged = applyOutboxTagsToFiles(files);

        expect(merged[0].pubMagicMetadata?.data._organizer_v1?.tags).toEqual([
            "keep",
        ]);
        expect(merged[1].pubMagicMetadata?.data._organizer_v1?.tags).toEqual([
            "pending",
        ]);
    });

    it("reconcileTagOutboxWithFiles removes entries confirmed on server", async () => {
        const {
            upsertTagOutboxEntry,
            getTagOutboxEntries,
            hydrateTagOutbox,
            reconcileTagOutboxWithFiles,
        } = await import("@/lib/tag-outbox");

        await hydrateTagOutbox();
        await upsertTagOutboxEntry(1, ["a"]);
        await upsertTagOutboxEntry(2, ["pending"]);

        await reconcileTagOutboxWithFiles([
            stubFile(1, ["a"]),
            stubFile(2, ["old"]),
        ]);

        expect(getTagOutboxEntries().map((entry) => entry.fileId)).toEqual([2]);
    });

    it("removeTagOutboxEntries clears multiple files in one persist", async () => {
        const {
            upsertTagOutboxEntry,
            removeTagOutboxEntries,
            getTagOutboxEntries,
            hydrateTagOutbox,
        } = await import("@/lib/tag-outbox");

        await hydrateTagOutbox();
        await upsertTagOutboxEntry(1, ["a"]);
        await upsertTagOutboxEntry(2, ["b"]);
        await removeTagOutboxEntries([1, 2]);

        expect(getTagOutboxEntries()).toEqual([]);
        expect(saveEncryptedTagOutbox).toHaveBeenCalledWith([], "test-cache-key");
    });

    it("upsertTagOutboxEntries persists once for many files", async () => {
        const {
            upsertTagOutboxEntries,
            getTagOutboxEntries,
            hydrateTagOutbox,
        } = await import("@/lib/tag-outbox");

        await hydrateTagOutbox();
        saveEncryptedTagOutbox.mockClear();

        await upsertTagOutboxEntries([
            { fileId: 1, intendedTags: ["a"] },
            { fileId: 2, intendedTags: ["b"] },
            { fileId: 3, intendedTags: ["c"] },
        ]);

        expect(getTagOutboxEntries().map((entry) => entry.fileId).sort()).toEqual([
            1, 2, 3,
        ]);
        expect(saveEncryptedTagOutbox).toHaveBeenCalledTimes(1);
    });

    it("enqueueTagOutboxEntries updates memory without awaiting persist", async () => {
        const {
            enqueueTagOutboxEntries,
            getTagOutboxEntry,
            hydrateTagOutbox,
        } = await import("@/lib/tag-outbox");

        await hydrateTagOutbox();
        enqueueTagOutboxEntries([{ fileId: 9, intendedTags: ["queued"] }]);

        expect(getTagOutboxEntry(9)?.intendedTags).toEqual(["queued"]);
    });

    it("persist continues after a failed IDB write", async () => {
        const {
            enqueueTagOutboxEntries,
            flushTagOutboxPersist,
            getTagOutboxEntries,
            hydrateTagOutbox,
        } = await import("@/lib/tag-outbox");

        await hydrateTagOutbox();
        saveEncryptedTagOutbox.mockRejectedValueOnce(new Error("idb"));
        enqueueTagOutboxEntries([{ fileId: 1, intendedTags: ["a"] }]);
        await flushTagOutboxPersist();

        saveEncryptedTagOutbox.mockResolvedValue(undefined);
        enqueueTagOutboxEntries([{ fileId: 2, intendedTags: ["b"] }]);
        await flushTagOutboxPersist();

        expect(
            getTagOutboxEntries()
                .map((entry) => entry.fileId)
                .sort(),
        ).toEqual([1, 2]);
        const lastWrite = saveEncryptedTagOutbox.mock.calls.at(-1)?.[0] as
            Array<{ fileId: number }> | undefined;
        expect(lastWrite?.map((entry) => entry.fileId).sort()).toEqual([1, 2]);
    });

    it("mergeAheadOrganizerTags keeps higher-version local tags the pull missed", async () => {
        const { mergeAheadOrganizerTags, hydrateTagOutbox } =
            await import("@/lib/tag-outbox");

        await hydrateTagOutbox();
        const pulled = fileWithOrganizerTags(
            {
                id: 1,
                pubMagicMetadata: {
                    version: 1,
                    count: 1,
                    data: { caption: "keep-me" },
                },
            } as EnteFile,
            ["old"],
        );
        const live = {
            ...fileWithOrganizerTags({ id: 1 } as EnteFile, ["new"]),
            pubMagicMetadata: {
                ...fileWithOrganizerTags({ id: 1 } as EnteFile, ["new"])
                    .pubMagicMetadata!,
                version: 2,
            },
        };

        const merged = mergeAheadOrganizerTags([pulled], [live]);

        expect(merged[0]?.pubMagicMetadata?.version).toBe(2);
        expect(merged[0]?.pubMagicMetadata?.data._organizer_v1?.tags).toEqual([
            "new",
        ]);
        expect(merged[0]?.pubMagicMetadata?.data.caption).toBe("keep-me");
    });

    it("mergeAheadOrganizerTags does not override a pending outbox overlay", async () => {
        const {
            enqueueTagOutboxEntries,
            hydrateTagOutbox,
            mergeAheadOrganizerTags,
        } = await import("@/lib/tag-outbox");

        await hydrateTagOutbox();
        enqueueTagOutboxEntries([{ fileId: 1, intendedTags: ["pending"] }]);

        const pulled = fileWithOrganizerTags({ id: 1 } as EnteFile, [
            "pending",
        ]);
        const live = {
            ...fileWithOrganizerTags({ id: 1 } as EnteFile, ["stale-acked"]),
            pubMagicMetadata: {
                ...fileWithOrganizerTags({ id: 1 } as EnteFile, ["stale-acked"])
                    .pubMagicMetadata!,
                version: 3,
            },
        };

        const merged = mergeAheadOrganizerTags([pulled], [live]);
        expect(merged[0]).toBe(pulled);
    });
});
