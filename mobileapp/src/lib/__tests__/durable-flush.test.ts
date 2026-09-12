import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("durable-flush", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("hasPendingDurableOutbox is false when all outboxes are empty", async () => {
        vi.doMock("@/lib/tag-outbox", () => ({
            flushTagOutboxPersist: vi.fn(async () => undefined),
            getTagOutboxEntries: () => [],
        }));
        vi.doMock("@/lib/favorite-outbox", () => ({
            flushFavoriteOutboxPersist: vi.fn(async () => undefined),
            getFavoriteOutboxEntries: () => [],
        }));
        vi.doMock("@/lib/favorite-membership", () => ({
            flushFavoriteMembershipPersist: vi.fn(async () => undefined),
        }));
        vi.doMock("@/lib/visibility-outbox", () => ({
            flushVisibilityOutboxPersist: vi.fn(async () => undefined),
            getVisibilityOutboxEntries: () => [],
        }));
        vi.doMock("@/lib/derived-replace-outbox", () => ({
            flushDerivedReplaceOutboxPersist: vi.fn(async () => undefined),
            getDerivedReplaceOutboxEntries: () => [],
        }));

        const { hasPendingDurableOutbox } = await import("@/lib/durable-flush");
        expect(hasPendingDurableOutbox()).toBe(false);
    });

    it("hasPendingDurableOutbox is true when any outbox has entries", async () => {
        vi.doMock("@/lib/tag-outbox", () => ({
            flushTagOutboxPersist: vi.fn(async () => undefined),
            getTagOutboxEntries: () => [{ fileId: 1, intendedTags: ["a"], enqueuedAt: 1 }],
        }));
        vi.doMock("@/lib/favorite-outbox", () => ({
            flushFavoriteOutboxPersist: vi.fn(async () => undefined),
            getFavoriteOutboxEntries: () => [],
        }));
        vi.doMock("@/lib/favorite-membership", () => ({
            flushFavoriteMembershipPersist: vi.fn(async () => undefined),
        }));
        vi.doMock("@/lib/visibility-outbox", () => ({
            flushVisibilityOutboxPersist: vi.fn(async () => undefined),
            getVisibilityOutboxEntries: () => [],
        }));
        vi.doMock("@/lib/derived-replace-outbox", () => ({
            flushDerivedReplaceOutboxPersist: vi.fn(async () => undefined),
            getDerivedReplaceOutboxEntries: () => [],
        }));

        const { hasPendingDurableOutbox } = await import("@/lib/durable-flush");
        expect(hasPendingDurableOutbox()).toBe(true);
    });

    it("flushAllDurableState awaits outboxes then library cache", async () => {
        const flushTag = vi.fn(async () => undefined);
        const flushFavorite = vi.fn(async () => undefined);
        const flushMembership = vi.fn(async () => undefined);
        const flushVisibility = vi.fn(async () => undefined);
        const flushDerived = vi.fn(async () => undefined);
        const flushLibrary = vi.fn(async () => undefined);

        vi.doMock("@/lib/tag-outbox", () => ({
            flushTagOutboxPersist: flushTag,
            getTagOutboxEntries: () => [],
        }));
        vi.doMock("@/lib/favorite-outbox", () => ({
            flushFavoriteOutboxPersist: flushFavorite,
            getFavoriteOutboxEntries: () => [],
        }));
        vi.doMock("@/lib/favorite-membership", () => ({
            flushFavoriteMembershipPersist: flushMembership,
        }));
        vi.doMock("@/lib/visibility-outbox", () => ({
            flushVisibilityOutboxPersist: flushVisibility,
            getVisibilityOutboxEntries: () => [],
        }));
        vi.doMock("@/lib/derived-replace-outbox", () => ({
            flushDerivedReplaceOutboxPersist: flushDerived,
            getDerivedReplaceOutboxEntries: () => [],
        }));
        vi.doMock("@/stores/library-store", () => ({
            flushLibraryCachePersist: flushLibrary,
        }));

        const { flushAllDurableState } = await import("@/lib/durable-flush");
        await flushAllDurableState();

        expect(flushTag).toHaveBeenCalledOnce();
        expect(flushFavorite).toHaveBeenCalledOnce();
        expect(flushMembership).toHaveBeenCalledOnce();
        expect(flushVisibility).toHaveBeenCalledOnce();
        expect(flushDerived).toHaveBeenCalledOnce();
        expect(flushLibrary).toHaveBeenCalledOnce();
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
