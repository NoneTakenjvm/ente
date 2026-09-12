import { create } from "zustand";
import type { StateCreator } from "zustand";
import { hasSessionCacheKey } from "@/lib/cache-key";
import {
    hydrateEmbeddingIndex,
    type EmbeddingMap,
} from "@/lib/kit-embedding";

interface EmbeddingIndexState {
    entries: EmbeddingMap;
    isHydrated: boolean;
    hydrate: () => Promise<void>;
    setEntries: (entries: EmbeddingMap) => void;
    reset: () => void;
}

const createEmbeddingIndexStore: StateCreator<EmbeddingIndexState> = (
    set,
) => ({
    entries: new Map(),
    isHydrated: false,

    hydrate: async (): Promise<void> => {
        if (!hasSessionCacheKey()) {
            return;
        }
        const entries = await hydrateEmbeddingIndex();
        set({ entries, isHydrated: true });
    },

    setEntries: (entries: EmbeddingMap): void => {
        set({ entries, isHydrated: true });
    },

    reset: (): void => {
        set({ entries: new Map(), isHydrated: false });
    },
});

export const useEmbeddingIndexStore = create<EmbeddingIndexState>(
    createEmbeddingIndexStore,
);
