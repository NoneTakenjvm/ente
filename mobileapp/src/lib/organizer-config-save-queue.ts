import { getEnteCore } from "@/core";
import type { OrganizerAppConfig } from "@/lib/organizer-config";

let pendingPatch: Partial<OrganizerAppConfig> = {};
let flushing = false;

const yieldToCoalesce = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

const mergePending = (
    current: Partial<OrganizerAppConfig>,
    patch: Partial<OrganizerAppConfig>,
): Partial<OrganizerAppConfig> => ({
    ...current,
    ...patch,
});

/**
 * Queue a partial app-config write. Rapid edits coalesce into one remote PUT.
 */
export const enqueueOrganizerConfigPatch = (
    patch: Partial<OrganizerAppConfig>,
): void => {
    pendingPatch = mergePending(pendingPatch, patch);
    void flushOrganizerConfigQueue();
};

const flushOrganizerConfigQueue = async (): Promise<void> => {
    if (flushing) {
        return;
    }
    flushing = true;
    try {
        while (Object.keys(pendingPatch).length > 0) {
            await yieldToCoalesce();
            const toFlush = pendingPatch;
            pendingPatch = {};
            try {
                await getEnteCore().patchOrganizerConfig(toFlush);
            } catch (error) {
                pendingPatch = mergePending(toFlush, pendingPatch);
                console.warn("Failed to persist organizer app config", error);
                break;
            }
        }
    } finally {
        flushing = false;
        if (Object.keys(pendingPatch).length > 0) {
            void flushOrganizerConfigQueue();
        }
    }
};

export const resetOrganizerConfigSaveQueue = (): void => {
    pendingPatch = {};
    flushing = false;
};
