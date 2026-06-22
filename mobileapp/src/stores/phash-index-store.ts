import { create } from "zustand";
import type { StateCreator } from "zustand";
import { hydratePhashIndex } from "@/lib/similarity-job";

interface PhashIndexState {
    entries: Map<number, string>;
    isHydrated: boolean;
    hydrate: () => Promise<void>;
    setEntries: (entries: Map<number, string>) => void;
    reset: () => void;
}

const createPhashIndexStore: StateCreator<PhashIndexState> = (set) => ({
    entries: new Map(),
    isHydrated: false,

    hydrate: async (): Promise<void> => {
        const entries = await hydratePhashIndex();
        set({ entries, isHydrated: true });
    },

    setEntries: (entries: Map<number, string>): void => {
        set({ entries, isHydrated: true });
    },

    reset: (): void => {
        set({ entries: new Map(), isHydrated: false });
    },
});

export const usePhashIndexStore = create<PhashIndexState>(createPhashIndexStore);
