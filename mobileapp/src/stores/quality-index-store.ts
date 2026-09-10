import { create } from "zustand";
import type { StateCreator } from "zustand";
import { hasSessionCacheKey } from "@/lib/cache-key";
import { hydrateQualityIndex } from "@/lib/image-quality-job";

interface QualityIndexState {
    entries: Map<number, number>;
    isHydrated: boolean;
    hydrate: () => Promise<void>;
    setEntries: (entries: Map<number, number>) => void;
    reset: () => void;
}

const createQualityIndexStore: StateCreator<QualityIndexState> = (set) => ({
    entries: new Map(),
    isHydrated: false,

    hydrate: async (): Promise<void> => {
        if (!hasSessionCacheKey()) {
            return;
        }
        const entries = await hydrateQualityIndex();
        set({ entries, isHydrated: true });
    },

    setEntries: (entries: Map<number, number>): void => {
        set({ entries, isHydrated: true });
    },

    reset: (): void => {
        set({ entries: new Map(), isHydrated: false });
    },
});

export const useQualityIndexStore = create<QualityIndexState>(
    createQualityIndexStore,
);
