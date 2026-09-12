import { getEnteCore } from "@/core";
import { isOrganizerConfigBootstrapped } from "@/core/organizer-config";
import type { OrganizerAppConfig } from "@/lib/organizer-config";
import { mergeCloudViewSessions } from "@/lib/view-sessions";

let pendingPatch: Partial<OrganizerAppConfig> = {};
let flushing = false;
let flushChain: Promise<void> = Promise.resolve();

const yieldToCoalesce = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Coalesce queued patches. `viewSessions` uses LWW merge so two rapid Recents
 * updates in one debounce window do not drop sessions.
 */
const mergePending = (
    current: Partial<OrganizerAppConfig>,
    patch: Partial<OrganizerAppConfig>,
): Partial<OrganizerAppConfig> => {
    const merged: Partial<OrganizerAppConfig> = { ...current, ...patch };
    if (
        current.viewSessions !== undefined &&
        patch.viewSessions !== undefined
    ) {
        merged.viewSessions = mergeCloudViewSessions(
            current.viewSessions,
            patch.viewSessions,
        );
    }
    return merged;
};

/**
 * Queue a partial app-config write. Rapid edits coalesce into one remote PUT.
 */
export const enqueueOrganizerConfigPatch = (
    patch: Partial<OrganizerAppConfig>,
): void => {
    pendingPatch = mergePending(pendingPatch, patch);
    if (!isOrganizerConfigBootstrapped()) {
        return;
    }
    void flushOrganizerConfigQueue();
};

/** True when a cloud config patch is queued or a flush is in flight. */
export const hasPendingOrganizerConfigPatch = (): boolean =>
    Object.keys(pendingPatch).length > 0 || flushing;

/**
 * Flush any patches queued before organizer bootstrap completed.
 */
export const flushOrganizerConfigQueueIfReady = (): Promise<void> => {
    if (!isOrganizerConfigBootstrapped()) {
        return Promise.resolve();
    }
    if (Object.keys(pendingPatch).length === 0 && !flushing) {
        return flushChain;
    }
    return flushOrganizerConfigQueue();
};

const flushOrganizerConfigQueue = (): Promise<void> => {
    flushChain = flushChain
        .catch(() => undefined)
        .then(async () => {
            if (flushing || !isOrganizerConfigBootstrapped()) {
                return;
            }
            flushing = true;
            let failed = false;
            try {
                while (Object.keys(pendingPatch).length > 0) {
                    await yieldToCoalesce();
                    const toFlush = pendingPatch;
                    pendingPatch = {};
                    try {
                        await getEnteCore().patchOrganizerConfig(toFlush);
                    } catch (error) {
                        pendingPatch = mergePending(toFlush, pendingPatch);
                        console.warn(
                            "Failed to persist organizer app config",
                            error,
                        );
                        failed = true;
                        break;
                    }
                }
            } finally {
                flushing = false;
                // Retry only when new work arrived during a successful flush —
                // not on hard failure (avoids a tight loop).
                if (!failed && Object.keys(pendingPatch).length > 0) {
                    void flushOrganizerConfigQueue();
                }
            }
        });
    return flushChain;
};

export const resetOrganizerConfigSaveQueue = (): void => {
    pendingPatch = {};
    flushing = false;
};
