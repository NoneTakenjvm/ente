import { create } from "zustand";
import type { RotationDegrees } from "@/lib/rotate";
import { nextPendingRotation } from "@/lib/rotate-draft";

/** How the stamp tool picks what to apply: a whole kit, or individual tags. */
export type StampPickMode = "kit" | "tag";

interface SelectionState {
    enabled: boolean;
    selectedIds: number[];
    /**
     * Stamp tool: pick tags/kits, then tap photos to apply.
     * Mutually exclusive with selection and rotate modes.
     */
    stampActive: boolean;
    stampTags: string[];
    /** Kit list vs individual tag picker in the stamp footer. */
    stampPickMode: StampPickMode;
    /** Tag picker sheet for the stamp tool (opened on enter when empty in tag mode). */
    stampSheetOpen: boolean;
    /**
     * Quick rotate: tap images to draft +90° CW; Apply uploads.
     * Mutually exclusive with selection and stamp.
     */
    rotateActive: boolean;
    /** Pending clockwise degrees per file id (omitted when 0°). */
    pendingRotations: Record<number, RotationDegrees>;
    /** True while Apply is uploading rotations (locks the grid). */
    rotateBusy: boolean;
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
    setRotateActive: (active: boolean) => void;
    bumpRotate: (fileId: number) => void;
    clearPendingRotations: () => void;
    removePendingRotation: (fileId: number) => void;
    setRotateBusy: (busy: boolean) => void;
    reset: () => void;
}

const initialState = {
    enabled: false,
    selectedIds: [] as number[],
    stampActive: false,
    stampTags: [] as string[],
    stampPickMode: "kit" as StampPickMode,
    stampSheetOpen: false,
    rotateActive: false,
    pendingRotations: {} as Record<number, RotationDegrees>,
    rotateBusy: false,
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
                rotateActive: false,
                pendingRotations: {},
                rotateBusy: false,
            });
            return;
        }
        set({
            enabled: true,
            stampActive: false,
            stampSheetOpen: false,
            rotateActive: false,
            pendingRotations: {},
            rotateBusy: false,
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
            rotateActive: false,
            pendingRotations: {},
            rotateBusy: false,
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
                rotateActive: false,
                pendingRotations: {},
                rotateBusy: false,
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

    setRotateActive: (active: boolean): void => {
        if (active) {
            set({
                rotateActive: true,
                enabled: false,
                selectedIds: [],
                stampActive: false,
                stampSheetOpen: false,
                pendingRotations: {},
                rotateBusy: false,
            });
            return;
        }
        set({ rotateActive: false, pendingRotations: {}, rotateBusy: false });
    },

    setRotateBusy: (busy: boolean): void => {
        set({ rotateBusy: busy });
    },

    bumpRotate: (fileId: number): void => {
        set((state) => {
            const nextDegrees = nextPendingRotation(
                state.pendingRotations[fileId],
            );
            const pendingRotations = { ...state.pendingRotations };
            if (nextDegrees === undefined) {
                delete pendingRotations[fileId];
            } else {
                pendingRotations[fileId] = nextDegrees;
            }
            return { pendingRotations };
        });
    },

    clearPendingRotations: (): void => {
        set({ pendingRotations: {} });
    },

    removePendingRotation: (fileId: number): void => {
        set((state) => {
            if (state.pendingRotations[fileId] === undefined) {
                return state;
            }
            const pendingRotations = { ...state.pendingRotations };
            delete pendingRotations[fileId];
            return { pendingRotations };
        });
    },

    reset: (): void => {
        set(initialState);
    },
}));
