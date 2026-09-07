import { create } from "zustand";

/** How the stamp tool picks what to apply: a whole kit, or individual tags. */
export type StampPickMode = "kit" | "tag";

interface SelectionState {
    enabled: boolean;
    selectedIds: number[];
    /**
     * Stamp tool: pick tags/kits, then tap photos to apply.
     * Mutually exclusive with selection mode.
     */
    stampActive: boolean;
    stampTags: string[];
    /** Kit list vs individual tag picker in the stamp footer. */
    stampPickMode: StampPickMode;
    /** Tag picker sheet for the stamp tool (opened on enter when empty in tag mode). */
    stampSheetOpen: boolean;
    setEnabled: (enabled: boolean) => void;
    toggle: (fileId: number) => void;
    selectMany: (fileIds: number[], mode: "add" | "toggle") => void;
    selectAll: (fileIds: number[]) => void;
    clear: () => void;
    pruneToVisible: (visibleIds: Set<number>) => void;
    setStampActive: (active: boolean) => void;
    setStampTags: (tags: string[]) => void;
    toggleStampTag: (tag: string) => void;
    setStampPickMode: (mode: StampPickMode) => void;
    setStampSheetOpen: (open: boolean) => void;
    clearStamp: () => void;
    reset: () => void;
}

const initialState = {
    enabled: false,
    selectedIds: [] as number[],
    stampActive: false,
    stampTags: [] as string[],
    stampPickMode: "kit" as StampPickMode,
    stampSheetOpen: false,
};

export const useSelectionStore = create<SelectionState>((set, get) => ({
    ...initialState,

    setEnabled: (enabled: boolean): void => {
        if (!enabled) {
            set({
                enabled: false,
                selectedIds: [],
                stampActive: false,
                stampSheetOpen: false,
            });
            return;
        }
        set({
            enabled: true,
            stampActive: false,
            stampSheetOpen: false,
            selectedIds: get().selectedIds,
        });
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

    selectAll: (fileIds: number[]): void => {
        set({
            enabled: true,
            stampActive: false,
            stampSheetOpen: false,
            selectedIds: [...new Set(fileIds)],
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

    setStampActive: (active: boolean): void => {
        if (active) {
            const { stampTags, stampPickMode } = get();
            set({
                stampActive: true,
                enabled: false,
                selectedIds: [],
                stampSheetOpen:
                    stampTags.length === 0 && stampPickMode === "tag",
            });
            return;
        }
        set({ stampActive: false, stampSheetOpen: false });
    },

    setStampTags: (tags: string[]): void => {
        const seen = new Set<string>();
        const stampTags: string[] = [];
        for (const tag of tags) {
            const trimmed = tag.trim();
            if (!trimmed || seen.has(trimmed)) {
                continue;
            }
            seen.add(trimmed);
            stampTags.push(trimmed);
        }
        set({ stampTags });
    },

    toggleStampTag: (tag: string): void => {
        const trimmed = tag.trim();
        if (!trimmed) {
            return;
        }
        const { stampTags } = get();
        const next = stampTags.includes(trimmed) ?
            stampTags.filter((entry) => entry !== trimmed) :
            [...stampTags, trimmed];
        set({ stampTags: next });
    },

    setStampPickMode: (mode: StampPickMode): void => {
        set({
            stampPickMode: mode,
            stampSheetOpen: false,
        });
    },

    setStampSheetOpen: (open: boolean): void => {
        set({ stampSheetOpen: open });
    },

    clearStamp: (): void => {
        set({
            stampActive: false,
            stampTags: [],
            stampPickMode: "kit",
            stampSheetOpen: false,
        });
    },

    reset: (): void => {
        set(initialState);
    },
}));
