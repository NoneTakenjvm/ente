/**
 * Unified flush of mutation outboxes + library cache so tab kill / logout
 * does not leave optimistic UI without retry intent on disk.
 */

import { flushFavoriteOutboxPersist, getFavoriteOutboxEntries } from "@/lib/favorite-outbox";
import { flushFavoriteMembershipPersist } from "@/lib/favorite-membership";
import {
    flushOrganizerConfigQueueIfReady,
    hasPendingOrganizerConfigPatch,
} from "@/lib/organizer-config-save-queue";
import {
    flushTagOutboxPersist,
    getTagOutboxEntries,
} from "@/lib/tag-outbox";
import {
    flushVisibilityOutboxPersist,
    getVisibilityOutboxEntries,
} from "@/lib/visibility-outbox";
import {
    flushDerivedReplaceOutboxPersist,
    getDerivedReplaceOutboxEntries,
} from "@/lib/derived-replace-outbox";
import { hasSessionCacheKey } from "@/lib/cache-key";

/** Longest a flush waits on the organizer config PUT (logout and lock await it). */
const ORGANIZER_FLUSH_WAIT_MS = 5_000;

let flushChain: Promise<void> = Promise.resolve();
let beforeUnloadInstalled = false;

/**
 * True when any mutation outbox or organizer-config cloud patch is pending.
 */
export const hasPendingDurableOutbox = (): boolean =>
    getTagOutboxEntries().length > 0 ||
    getFavoriteOutboxEntries().length > 0 ||
    getVisibilityOutboxEntries().length > 0 ||
    getDerivedReplaceOutboxEntries().length > 0 ||
    hasPendingOrganizerConfigPatch();

/**
 * Await encrypt+IDB for all outboxes, organizer cloud config, and library cache.
 *
 * [Note: Local flush before network]
 *
 * Every on-device write runs first and independently (one failure does not skip
 * the rest), then the organizer config PUT gets a bounded wait so a hung request
 * cannot stall logout, lock or later flushes. Without the session cache key
 * (locked or logged out) there is nothing that can be encrypted, so it no-ops.
 */
export const flushAllDurableState = (): Promise<void> => {
    flushChain = flushChain
        .catch(() => undefined)
        .then(async () => {
            if (!hasSessionCacheKey()) {
                return;
            }
            const [
                { flushLibraryCachePersist },
                { flushTagIndexPersist },
                { flushThumbnailLruTouches },
                { flushFileCiphertextLruTouches },
            ] = await Promise.all([
                import("@/stores/library-store"),
                import("@/stores/tag-store"),
                import("@/db/thumbnails"),
                import("@/db/file-ciphertexts"),
            ]);
            const results = await Promise.allSettled([
                flushTagOutboxPersist(),
                flushFavoriteOutboxPersist(),
                flushFavoriteMembershipPersist(),
                flushVisibilityOutboxPersist(),
                flushDerivedReplaceOutboxPersist(),
                flushLibraryCachePersist(),
                flushTagIndexPersist(),
                flushThumbnailLruTouches(),
                flushFileCiphertextLruTouches(),
            ]);
            await Promise.race([
                flushOrganizerConfigQueueIfReady(),
                new Promise<void>((resolve) =>
                    setTimeout(resolve, ORGANIZER_FLUSH_WAIT_MS)),
            ]);
            const failure = results.find(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );
            if (failure) {
                throw failure.reason;
            }
        });
    return flushChain;
};

/**
 * Fire-and-forget flush for pagehide / visibilitychange.
 */
export const requestDurableFlush = (): void => {
    flushAllDurableState().catch((error: unknown) => {
        console.warn("[durable-flush] flush failed", error);
    });
};

/**
 * Warn before tab close when any outbox is non-empty, and keep a single
 * pagehide/visibility flush path (individual outbox listeners can remain).
 */
export const installDurableFlushListeners = (): void => {
    if (typeof window === "undefined" || beforeUnloadInstalled) {
        return;
    }
    beforeUnloadInstalled = true;

    const flushOnHide = (): void => {
        requestDurableFlush();
    };
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            flushOnHide();
        }
    });
    window.addEventListener("beforeunload", (event: BeforeUnloadEvent) => {
        if (!hasPendingDurableOutbox()) {
            return;
        }
        requestDurableFlush();
        event.preventDefault();
        event.returnValue = "";
    });
};
