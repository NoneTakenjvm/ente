/**
 * Tab-close warning while mutations are still queued. Flushes themselves are
 * registered by each module with `session-lifecycle`.
 */

import { getFavoriteOutboxEntries } from "@/lib/favorite-outbox";
import { hasPendingOrganizerConfigPatch } from "@/lib/organizer-config-save-queue";
import { flushAll } from "@/lib/session-lifecycle";
import { getTagOutboxEntries } from "@/lib/tag-outbox";
import { getVisibilityOutboxEntries } from "@/lib/visibility-outbox";
import { getDerivedReplaceOutboxEntries } from "@/lib/derived-replace-outbox";

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
 * Warn before tab close when any outbox is non-empty and flush on the way out.
 */
export const installDurableFlushListeners = (): void => {
    if (typeof window === "undefined" || beforeUnloadInstalled) {
        return;
    }
    beforeUnloadInstalled = true;
    window.addEventListener("beforeunload", (event: BeforeUnloadEvent) => {
        if (!hasPendingDurableOutbox()) {
            return;
        }
        flushAll().catch((error: unknown) => {
            console.warn("[durable-flush] flush failed", error);
        });
        event.preventDefault();
        event.returnValue = "";
    });
};
