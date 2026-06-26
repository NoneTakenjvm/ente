import { create } from "zustand";

interface SelectionState {
    enabled: boolean;
    selectedIds: number[];
    setEnabled: (enabled: boolean) => void;
    toggle: (fileId: number) => void;
    selectMany: (fileIds: number[], mode: "add" | "toggle") => void;
    clear: () => void;
    pruneToVisible: (visibleIds: Set<number>) => void;
    reset: () => void;
}

const initialState = {
    enabled: false,
    selectedIds: [] as number[],
};

export const useSelectionStore = create<SelectionState>((set, get) => ({
    ...initialState,

    setEnabled: (enabled: boolean): void => {
        if (!enabled) {
            set({ enabled: false, selectedIds: [] });
            return;
        }
        set({ enabled: true });
    },

    toggle: (fileId: number): void => {
        const { selectedIds } = get();
        const index = selectedIds.indexOf(fileId);
        if (index === -1) {
            set({ selectedIds: [...selectedIds, fileId] });
            return;
        }
        const next = [...selectedIds];
        next.splice(index, 1);
        set({ selectedIds: next });
    },

    selectMany: (fileIds: number[], mode: "add" | "toggle"): void => {
        set((state) => {
            const next = new Set(state.selectedIds);
            for (const fileId of fileIds) {
                if (mode === "add") {
                    next.add(fileId);
                } else if (next.has(fileId)) {
                    next.delete(fileId);
                } else {
                    next.add(fileId);
                }
            }
            return { selectedIds: [...next] };
        });
    },

    clear: (): void => {
        set({ selectedIds: [] });
    },

    pruneToVisible: (visibleIds: Set<number>): void => {
        set((state) => {
            const pruned = state.selectedIds.filter((id) => visibleIds.has(id));
            if (pruned.length === state.selectedIds.length) {
                return state;
            }
            return { selectedIds: pruned };
        });
    },

    reset: (): void => {
        set(initialState);
    },
}));
