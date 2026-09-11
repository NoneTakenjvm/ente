/**
 * Unified flush of mutation outboxes + library cache so tab kill / logout
 * does not leave optimistic UI without retry intent on disk.
 */

import { flushFavoriteOutboxPersist, getFavoriteOutboxEntries } from "@/lib/favorite-outbox";
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

let flushChain: Promise<void> = Promise.resolve();
let beforeUnloadInstalled = false;

/**
 * True when any mutation outbox still has pending entries in memory.
 */
export const hasPendingDurableOutbox = (): boolean =>
    getTagOutboxEntries().length > 0 ||
    getFavoriteOutboxEntries().length > 0 ||
    getVisibilityOutboxEntries().length > 0 ||
    getDerivedReplaceOutboxEntries().length > 0;

/**
 * Await encrypt+IDB for all outboxes and the debounced library snapshot.
 */
export const flushAllDurableState = (): Promise<void> => {
    flushChain = flushChain
        .catch(() => undefined)
        .then(async () => {
            await Promise.all([
                flushTagOutboxPersist(),
                flushFavoriteOutboxPersist(),
                flushVisibilityOutboxPersist(),
                flushDerivedReplaceOutboxPersist(),
            ]);
            const { flushLibraryCachePersist } = await import(
                "@/stores/library-store"
            );
            await flushLibraryCachePersist();
        });
    return flushChain;
};

/**
 * Fire-and-forget flush for pagehide / visibilitychange.
 */
export const requestDurableFlush = (): void => {
    void flushAllDurableState();
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
