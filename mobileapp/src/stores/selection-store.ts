import { create } from "zustand";
import type { NormalizedCropRect, PendingCrop } from "@/lib/crop-draft";
import type { RotationDegrees } from "@/lib/rotate";
import { nextPendingRotation } from "@/lib/rotate-draft";
import { registerReset } from "@/lib/session-lifecycle";

/** How the stamp tool picks what to apply: a whole kit, or individual tags. */
export type StampPickMode = "kit" | "tag";

interface SelectionState {
    enabled: boolean;
    selectedIds: number[];
    /**
     * Stamp tool: pick tags/kits, then tap photos to apply.
     * Mutually exclusive with selection, rotate and crop modes.
     */
    stampActive: boolean;
    stampTags: string[];
    /** Kit list vs individual tag picker in the stamp footer. */
    stampPickMode: StampPickMode;
    /** Tag picker sheet for the stamp tool (opened on enter when empty in tag mode). */
    stampSheetOpen: boolean;
    /**
     * Quick rotate: tap images to draft +90° CW; Apply uploads.
     * Mutually exclusive with selection, stamp and crop.
     */
    rotateActive: boolean;
    /** Pending clockwise degrees per file id (omitted when 0°). */
    pendingRotations: Record<number, RotationDegrees>;
    /** True while Apply is uploading rotations (locks the grid). */
    rotateBusy: boolean;
    /**
     * Quick crop: tap images to draft a crop box; Apply uploads.
     * Mutually exclusive with selection, stamp and rotate.
     */
    cropActive: boolean;
    /** Draft crop box per file id. */
    pendingCrops: Record<number, PendingCrop>;
    /** True while Apply is uploading crops (locks the grid). */
    cropBusy: boolean;
    setEnabled: (enabled: boolean) => void;
    toggle: (fileId: number) => void;
    selectMany: (fileIds: number[], mode: "add" | "toggle" | "set") => void;
    selectAll: (fileIds: number[]) => void;
    clear: () => void;
    pruneToVisible: (visibleIds: Set<number>) => void;
    setStampActive: (active: boolean) => void;
    setStampTags: (tags: string[]) => void;
    toggleStampTag: (tag: string) => void;
    setStampPickMode: (mode: StampPickMode) => void;
    setStampSheetOpen: (open: boolean) => void;
    setRotateActive: (active: boolean) => void;
    bumpRotate: (fileId: number) => void;
    clearPendingRotations: () => void;
    removePendingRotation: (fileId: number) => void;
    setRotateBusy: (busy: boolean) => void;
    setCropActive: (active: boolean) => void;
    /** Add a draft crop; does nothing when the file already has one. */
    addPendingCrop: (fileId: number, crop: PendingCrop) => void;
    setPendingCropRect: (fileId: number, rect: NormalizedCropRect) => void;
    removePendingCrop: (fileId: number) => void;
    clearPendingCrops: () => void;
    setCropBusy: (busy: boolean) => void;
    reset: () => void;
}

const selectedIdSets = new WeakMap<number[], Set<number>>();

/** Crop fields with the tool off; spread into any set() that leaves crop mode. */
const cropOff = {
    cropActive: false,
    pendingCrops: {} as Record<number, PendingCrop>,
    cropBusy: false,
};

/** Rotate fields with the tool off; spread into any set() that leaves rotate mode. */
const rotateOff = {
    rotateActive: false,
    pendingRotations: {} as Record<number, RotationDegrees>,
    rotateBusy: false,
};

/** Stamp fields with the tool off; spread into any set() that leaves stamp mode. */
const stampOff = {
    stampActive: false,
    stampSheetOpen: false,
};

const initialState = {
    enabled: false,
    selectedIds: [] as number[],
    stampTags: [] as string[],
    stampPickMode: "kit" as StampPickMode,
    ...stampOff,
    ...rotateOff,
    ...cropOff,
};

export const useSelectionStore = create<SelectionState>((set, get) => ({
    ...initialState,

    setEnabled: (enabled: boolean): void => {
        set({
            enabled,
            ...(enabled ? {} : { selectedIds: [] }),
            ...stampOff,
            ...rotateOff,
            ...cropOff,
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

    selectMany: (fileIds: number[], mode: "add" | "toggle" | "set"): void => {
        set((state) => {
            if (mode === "set") {
                const unique = [...new Set(fileIds)];
                const current = new Set(state.selectedIds);
                if (
                    unique.length === current.size &&
                    unique.every((id) => current.has(id))
                ) {
                    return state;
                }
                return { selectedIds: unique };
            }
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
            ...stampOff,
            ...rotateOff,
            ...cropOff,
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
                enabled: false,
                selectedIds: [],
                ...rotateOff,
                ...cropOff,
                stampActive: true,
                stampSheetOpen:
                    stampTags.length === 0 && stampPickMode === "tag",
            });
            return;
        }
        set(stampOff);
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

    setRotateActive: (active: boolean): void => {
        if (active) {
            set({
                enabled: false,
                selectedIds: [],
                ...stampOff,
                ...rotateOff,
                ...cropOff,
                rotateActive: true,
            });
            return;
        }
        set(rotateOff);
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

    setCropActive: (active: boolean): void => {
        if (active) {
            set({
                enabled: false,
                selectedIds: [],
                ...stampOff,
                ...rotateOff,
                ...cropOff,
                cropActive: true,
            });
            return;
        }
        set(cropOff);
    },

    setCropBusy: (busy: boolean): void => {
        set({ cropBusy: busy });
    },

    addPendingCrop: (fileId: number, crop: PendingCrop): void => {
        set((state) => {
            if (state.pendingCrops[fileId] !== undefined) {
                return state;
            }
            return { pendingCrops: { ...state.pendingCrops, [fileId]: crop } };
        });
    },

    setPendingCropRect: (fileId: number, rect: NormalizedCropRect): void => {
        set((state) => {
            const current = state.pendingCrops[fileId];
            if (current === undefined) {
                return state;
            }
            return {
                pendingCrops: {
                    ...state.pendingCrops,
                    [fileId]: { ...current, rect },
                },
            };
        });
    },

    removePendingCrop: (fileId: number): void => {
        set((state) => {
            if (state.pendingCrops[fileId] === undefined) {
                return state;
            }
            const pendingCrops = { ...state.pendingCrops };
            delete pendingCrops[fileId];
            return { pendingCrops };
        });
    },

    clearPendingCrops: (): void => {
        set({ pendingCrops: {} });
    },

    reset: (): void => {
        set(initialState);
    },
}));

/**
 * Memoised Set view of `selectedIds` for O(1) membership checks. The store
 * replaces the array on every change, so one Set is built per selection.
 */
export const selectedIdSet = (ids: number[]): Set<number> => {
    let idSet = selectedIdSets.get(ids);
    if (!idSet) {
        idSet = new Set(ids);
        selectedIdSets.set(ids, idSet);
    }
    return idSet;
};

registerReset(() => {
    useSelectionStore.getState().reset();
});
