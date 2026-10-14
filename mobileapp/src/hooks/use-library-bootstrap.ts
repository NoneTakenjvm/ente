import { useEffect, useRef, useState } from "react";
import { useLibraryStore } from "@/stores/library-store";
import { isSessionAuthenticated } from "@/stores/session-store";
import { hydrateDerivedReplaceOutbox } from "@/lib/derived-replace-outbox";
import { libraryOutboxContext } from "@/lib/library-outbox-context";
import { startOutboxRunner } from "@/lib/outbox-runner";
import { registerReset } from "@/lib/session-lifecycle";

export interface UseLibraryBootstrapOptions {
    /** Extra work after cache load and remote sync (e.g. phash hydrate). */
    afterSync?: () => Promise<void>;
}

/**
 * [Note: One library bootstrap per session]
 *
 * Every page mounts {@link useLibraryBootstrap}. The cache decrypt, outbox
 * hydrate, runner start and first sync run once per session and later pages
 * await the same promise (then refresh with a background sync) instead of
 * re-decrypting the whole library on each navigation. Logout and lock clear
 * it through {@link resetLibraryBootstrap}.
 */
let sessionBootstrap: Promise<void> | undefined;

/** Forget the session bootstrap so the next page mount loads from scratch. */
export const resetLibraryBootstrap = (): void => {
    sessionBootstrap = undefined;
};

/**
 * Load encrypted cache then sync from Ente once per authenticated session.
 */
export const useLibraryBootstrap = (
    options: UseLibraryBootstrapOptions = {},
): boolean => {
    const bootstrapFromCache = useLibraryStore(
        (state) => state.bootstrapFromCache,
    );
    const syncRemote = useLibraryStore((state) => state.syncRemote);
    // Callers pass afterSync inline; a ref keeps it out of the effect deps so
    // re-renders don't cancel the load before initialLoadDone is set.
    const afterSyncRef = useRef(options.afterSync);
    useEffect(() => {
        afterSyncRef.current = options.afterSync;
    });

    const [initialLoadDone, setInitialLoadDone] = useState(false);

    useEffect(() => {
        if (!isSessionAuthenticated()) {
            return () => {};
        }

        let cancelled = false;

        const bootstrap = async (): Promise<void> => {
            // bootstrapFromCache hydrates the tag/favourite/visibility outboxes.
            await bootstrapFromCache();
            await hydrateDerivedReplaceOutbox();
            startOutboxRunner(libraryOutboxContext);
            await syncRemote().catch(() => {
                // syncRemote records the error; later page mounts sync again.
            });
        };

        const load = async () => {
            try {
                if (sessionBootstrap) {
                    await sessionBootstrap;
                    void syncRemote().catch(() => {
                        // syncRemote records the error in the library store.
                    });
                } else {
                    sessionBootstrap = bootstrap().catch((error: unknown) => {
                        // Let the next page mount retry a failed bootstrap.
                        sessionBootstrap = undefined;
                        throw error;
                    });
                    await sessionBootstrap;
                }
                await afterSyncRef.current?.();
            } catch (error) {
                console.warn("[library] bootstrap failed", error);
            } finally {
                if (!cancelled) {
                    setInitialLoadDone(true);
                }
            }
        };

        void load();
        return () => {
            cancelled = true;
        };
    }, [bootstrapFromCache, syncRemote]);
    return initialLoadDone;
};

registerReset(resetLibraryBootstrap);
