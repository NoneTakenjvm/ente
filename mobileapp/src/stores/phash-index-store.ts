import { create } from "zustand";
import type { StateCreator } from "zustand";
import type { PhashEntry } from "@/lib/crop-match";
import { hasSessionCacheKey } from "@/lib/cache-key";
import { hydratePhashIndex } from "@/lib/similarity-job";

interface PhashIndexState {
    entries: Map<number, PhashEntry>;
    isHydrated: boolean;
    hydrate: () => Promise<void>;
    setEntries: (entries: Map<number, PhashEntry>) => void;
    reset: () => void;
}

const createPhashIndexStore: StateCreator<PhashIndexState> = (set) => ({
    entries: new Map(),
    isHydrated: false,

    hydrate: async (): Promise<void> => {
        if (!hasSessionCacheKey()) {
            return;
        }
        const entries = await hydratePhashIndex();
        set({ entries, isHydrated: true });
    },

    setEntries: (entries: Map<number, PhashEntry>): void => {
        set({ entries, isHydrated: true });
    },

    reset: (): void => {
        set({ entries: new Map(), isHydrated: false });
    },
});

export const usePhashIndexStore = create<PhashIndexState>(createPhashIndexStore);
