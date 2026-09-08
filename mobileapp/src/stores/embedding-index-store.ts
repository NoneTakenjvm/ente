import { create } from "zustand";
import type { StateCreator } from "zustand";
import { hydrateEmbeddingIndex } from "@/lib/kit-embedding";

interface EmbeddingIndexState {
    entries: Map<number, number[]>;
    isHydrated: boolean;
    hydrate: () => Promise<void>;
    setEntries: (entries: Map<number, number[]>) => void;
    reset: () => void;
}

const createEmbeddingIndexStore: StateCreator<EmbeddingIndexState> = (
    set,
) => ({
    entries: new Map(),
    isHydrated: false,

    hydrate: async (): Promise<void> => {
        const entries = await hydrateEmbeddingIndex();
        set({ entries, isHydrated: true });
    },

    setEntries: (entries: Map<number, number[]>): void => {
        set({ entries, isHydrated: true });
    },

    reset: (): void => {
        set({ entries: new Map(), isHydrated: false });
    },
});

export const useEmbeddingIndexStore = create<EmbeddingIndexState>(
    createEmbeddingIndexStore,
);
