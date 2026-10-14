import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("durable-flush", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const mockOutboxes = (tagEntries: unknown[]): void => {
        vi.doMock("@/lib/tag-outbox", () => ({
            getTagOutboxEntries: () => tagEntries,
        }));
        vi.doMock("@/lib/favorite-outbox", () => ({
            getFavoriteOutboxEntries: () => [],
        }));
        vi.doMock("@/lib/visibility-outbox", () => ({
            getVisibilityOutboxEntries: () => [],
        }));
        vi.doMock("@/lib/derived-replace-outbox", () => ({
            getDerivedReplaceOutboxEntries: () => [],
        }));
        vi.doMock("@/lib/organizer-config-save-queue", () => ({
            hasPendingOrganizerConfigPatch: () => false,
        }));
    };

    it("hasPendingDurableOutbox is false when all outboxes are empty", async () => {
        mockOutboxes([]);
        const { hasPendingDurableOutbox } = await import("@/lib/durable-flush");
        expect(hasPendingDurableOutbox()).toBe(false);
    });

    it("hasPendingDurableOutbox is true when any outbox has entries", async () => {
        mockOutboxes([{ fileId: 1, intendedTags: ["a"], enqueuedAt: 1 }]);
        const { hasPendingDurableOutbox } = await import("@/lib/durable-flush");
        expect(hasPendingDurableOutbox()).toBe(true);
    });
});

describe("session-lifecycle", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("flushAll runs every registered flush even when one fails", async () => {
        vi.doMock("@/lib/cache-key", () => ({
            hasSessionCacheKey: () => true,
        }));
        const { registerFlush, flushAll } = await import(
            "@/lib/session-lifecycle"
        );
        const failing = vi.fn(async () => {
            throw new Error("boom");
        });
        const passing = vi.fn(async () => undefined);
        registerFlush(failing);
        registerFlush(passing);

        await expect(flushAll()).rejects.toThrow("boom");
        expect(failing).toHaveBeenCalledOnce();
        expect(passing).toHaveBeenCalledOnce();
    });

    it("flushAll no-ops without a session cache key", async () => {
        vi.doMock("@/lib/cache-key", () => ({
            hasSessionCacheKey: () => false,
        }));
        const { registerFlush, flushAll } = await import(
            "@/lib/session-lifecycle"
        );
        const flush = vi.fn(async () => undefined);
        registerFlush(flush);

        await flushAll();
        expect(flush).not.toHaveBeenCalled();
    });

    it("runSessionResets runs every reset even when one throws", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const { registerReset, runSessionResets } = await import(
            "@/lib/session-lifecycle"
        );
        const throwing = vi.fn(() => {
            throw new Error("boom");
        });
        const other = vi.fn();
        registerReset(throwing);
        registerReset(other);

        runSessionResets();
        expect(throwing).toHaveBeenCalledOnce();
        expect(other).toHaveBeenCalledOnce();
    });
});

describe("gallery-scroll-activity waitWhileGalleryScrolling", () => {
    it("resolves immediately when not scrolling", async () => {
        const { waitWhileGalleryScrolling, noteGalleryScrollActivity } =
            await import("@/lib/gallery-scroll-activity");
        // Ensure idle
        noteGalleryScrollActivity();
        await new Promise((r) => setTimeout(r, 200));
        const start = Date.now();
        await waitWhileGalleryScrolling();
        expect(Date.now() - start).toBeLessThan(100);
    });
});

describe("session-invalidation", () => {
    it("notifies unauthorized handler once", async () => {
        const { notifyUnauthorized, resetUnauthorizedGate, setUnauthorizedHandler } =
            await import("@/lib/session-invalidation");
        resetUnauthorizedGate();
        const handler = vi.fn();
        setUnauthorizedHandler(handler);
        notifyUnauthorized();
        notifyUnauthorized();
        expect(handler).toHaveBeenCalledOnce();
    });
});
