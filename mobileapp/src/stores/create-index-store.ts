import { create } from "zustand";
import type { UseBoundStore, StoreApi } from "zustand";
import { hasSessionCacheKey } from "@/lib/cache-key";
import { registerReset } from "@/lib/session-lifecycle";

export interface IndexStoreState<Entries> {
    entries: Entries;
    isHydrated: boolean;
    /** Loads the persisted index once; concurrent callers share one load. */
    ensureHydrated: () => Promise<void>;
    setEntries: (entries: Entries) => void;
    reset: () => void;
}

/**
 * Builds a store for an encrypted, persisted index (embeddings, phashes,
 * quality). `loadEntries` is only called while a session cache key exists, and
 * the store clears itself on logout.
 */
export const createIndexStore = <Entries>(
    emptyEntries: () => Entries,
    loadEntries: () => Promise<Entries>,
): UseBoundStore<StoreApi<IndexStoreState<Entries>>> => {
    let inFlight: Promise<void> | null = null;

    const useStore = create<IndexStoreState<Entries>>((set, get) => ({
        entries: emptyEntries(),
        isHydrated: false,

        ensureHydrated: (): Promise<void> => {
            if (get().isHydrated || !hasSessionCacheKey()) {
                return Promise.resolve();
            }
            inFlight ??= loadEntries()
                .then((entries) => {
                    set({ entries, isHydrated: true });
                })
                .finally(() => {
                    inFlight = null;
                });
            return inFlight;
        },

        setEntries: (entries: Entries): void => {
            set({ entries, isHydrated: true });
        },

        reset: (): void => {
            inFlight = null;
            set({ entries: emptyEntries(), isHydrated: false });
        },
    }));

    registerReset(() => {
        useStore.getState().reset();
    });

    return useStore;
};
