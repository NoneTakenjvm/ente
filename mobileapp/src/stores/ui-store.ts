import { create } from "zustand";
import type { BackgroundJobStatus } from "@/hooks/use-job";
import { reconcileShuffledIds } from "@/lib/shuffle-files";
import type { ImageQualitySort } from "@/lib/image-quality";
import type { RelativeSort } from "@/lib/relative-sort";
import type { ImageSizeSort, UploadedAtSort } from "@/lib/sort-files";
import type { TagFilterFitSort } from "@/lib/tag-filter-fit-sort";
import type { TagFilterSelection } from "@/lib/tag-filter";
import {
    deviceViewerSize,
    type ViewportFitSort,
} from "@/lib/viewport-fit";
import { registerReset } from "@/lib/session-lifecycle";

/** How the active nearness sort was entered (kit picker vs custom filter). */
type NearnessSource = "kit" | "filter";

/**
 * The gallery's session-only reorder. At most one is active; `undefined` is
 * the library's default order.
 *
 * - `tagFilterFit`: CLIP fit to the active tag filter; needs tag clauses.
 * - `relative`: greedy CLIP nearest/farthest-neighbor chain. `seed` picks the
 *   random first tip; `startFileId` (viewer "Set Relative") overrides it while
 *   it is still in the filtered set.
 * - `nearness`: CLIP nearness to seeds matching `filter`, independent of the
 *   gallery filter.
 */
export type GalleryOrdering =
    { kind: "viewportFit"; direction: Exclude<ViewportFitSort, "none"> } |
    { kind: "uploadedAt"; direction: Exclude<UploadedAtSort, "none"> } |
    { kind: "imageSize"; direction: Exclude<ImageSizeSort, "none"> } |
    { kind: "imageQuality"; direction: Exclude<ImageQualitySort, "none"> } |
    { kind: "tagFilterFit"; direction: Exclude<TagFilterFitSort, "none"> } |
    {
        kind: "relative";
        direction: Exclude<RelativeSort, "none">;
        seed: number;
        startFileId: number | undefined;
    } |
    { kind: "nearness"; filter: TagFilterSelection; source: NearnessSource } |
    { kind: "shuffled"; seed: number; fileIds: number[] };

interface UploadJobState {
    status: BackgroundJobStatus;
    progress: { current: number; total: number };
    panelOpen: boolean;
    setStatus: (status: BackgroundJobStatus) => void;
    setProgress: (current: number, total: number) => void;
    setPanelOpen: (open: boolean) => void;
    resetJob: () => void;
    reset: () => void;
}

const initialUploadJob: Pick<
    UploadJobState,
    "status" | "progress" | "panelOpen"
> = {
    status: "idle",
    progress: { current: 0, total: 0 },
    panelOpen: false,
};

export const useUploadJobStore = create<UploadJobState>((set) => ({
    ...initialUploadJob,
    setStatus: (status: BackgroundJobStatus): void => {
        set({ status });
    },
    setProgress: (current: number, total: number): void => {
        set({ progress: { current, total } });
    },
    setPanelOpen: (open: boolean): void => {
        set({ panelOpen: open });
    },
    resetJob: (): void => {
        set((state) => ({
            status: "idle",
            progress: { current: 0, total: 0 },
            panelOpen: state.panelOpen,
        }));
    },
    reset: (): void => {
        set(initialUploadJob);
    },
}));

interface UIState {
    ordering: GalleryOrdering | undefined;
    /** Replace the active ordering; `undefined` returns to the default order. */
    setOrdering: (next: GalleryOrdering | undefined) => void;
    /**
     * Target viewport size (CSS px) for fit sort + crop defaults (session-only).
     * Initialized once from the live device; not updated on rotate/resize.
     */
    viewportTargetWidth: number;
    viewportTargetHeight: number;
    setViewportTargetSize: (width: number, height: number) => void;
    /** Re-fill target W×H from the current live device viewport. */
    resetViewportTargetToDevice: () => void;
    /**
     * Crop editor "Lock aspect ratio" (session-only). Default on; survives
     * lock/unlock in this tab until the PWA process is discarded.
     */
    cropLockAspect: boolean;
    setCropLockAspect: (locked: boolean) => void;
    /** Rank the gallery against this file; starts a closest relative sort if none is active. */
    setRelativeStartFileId: (fileId: number) => void;
    /** Pick a new random start and rebuild the relative chain. */
    reapplyRelativeSort: () => void;
    /**
     * When kit likeness is on, soft-penalize files closer to other kits.
     * Session-only; ignored for Filter nearness. Default on.
     */
    kitLikenessRivalPenalty: boolean;
    setKitLikenessRivalPenalty: (enabled: boolean) => void;
    /**
     * Kit preset ids omitted from rival penalties and pushed to the bottom
     * of the Choose kit list. Session-only; still selectable as the active kit.
     */
    excludedKitLikenessIds: ReadonlySet<string>;
    toggleKitLikenessExcluded: (presetId: string) => void;
    /**
     * Bumped whenever nearness is (re)applied so the gallery can snapshot
     * order once — library/tag edits must not rebuild until reapply.
     */
    nearnessEpoch: number;
    /** Rebuild nearness order from the current library (same filter). */
    reapplyNearness: () => void;
    reconcileMediaShuffle: (fileIds: readonly number[]) => void;
    substituteMediaShuffleFileId: (oldId: number, newId: number) => void;
}

export const useUIStore = create<UIState>((set) => {
    const initialViewportTarget = deviceViewerSize();
    return {
        ordering: undefined,
        setOrdering: (next: GalleryOrdering | undefined): void => {
            set((state) => ({
                ordering: next,
                ...(next?.kind === "nearness" ?
                    { nearnessEpoch: state.nearnessEpoch + 1 } :
                    {}),
            }));
        },
        viewportTargetWidth: initialViewportTarget.width,
        viewportTargetHeight: initialViewportTarget.height,
        setViewportTargetSize: (width: number, height: number): void => {
            const nextWidth = Math.max(1, Math.round(width));
            const nextHeight = Math.max(1, Math.round(height));
            set({
                viewportTargetWidth: nextWidth,
                viewportTargetHeight: nextHeight,
            });
        },
        resetViewportTargetToDevice: (): void => {
            const size = deviceViewerSize();
            set({
                viewportTargetWidth: size.width,
                viewportTargetHeight: size.height,
            });
        },
        cropLockAspect: true,
        setCropLockAspect: (locked: boolean): void => {
            set({ cropLockAspect: locked });
        },
        setRelativeStartFileId: (fileId: number): void => {
            set((state) => {
                if (state.ordering?.kind !== "relative") {
                    return {
                        ordering: {
                            kind: "relative",
                            direction: "closest",
                            seed: Date.now(),
                            startFileId: fileId,
                        },
                    };
                }
                return { ordering: { ...state.ordering, startFileId: fileId } };
            });
        },
        reapplyRelativeSort: (): void => {
            set((state) => {
                if (state.ordering?.kind !== "relative") {
                    return state;
                }
                return {
                    ordering: {
                        ...state.ordering,
                        seed: Date.now(),
                        startFileId: undefined,
                    },
                };
            });
        },
        kitLikenessRivalPenalty: true,
        setKitLikenessRivalPenalty: (enabled: boolean): void => {
            set((state) => ({
                kitLikenessRivalPenalty: enabled,
                // Rebuild frozen kit-likeness order when the toggle changes.
                ...(state.ordering?.kind === "nearness" &&
                state.ordering.source === "kit" ?
                    { nearnessEpoch: state.nearnessEpoch + 1 } :
                    {}),
            }));
        },
        excludedKitLikenessIds: new Set(),
        toggleKitLikenessExcluded: (presetId: string): void => {
            set((state) => {
                const next = new Set(state.excludedKitLikenessIds);
                if (next.has(presetId)) {
                    next.delete(presetId);
                } else {
                    next.add(presetId);
                }
                return {
                    excludedKitLikenessIds: next,
                    ...(state.ordering?.kind === "nearness" &&
                    state.ordering.source === "kit" &&
                    state.kitLikenessRivalPenalty ?
                        { nearnessEpoch: state.nearnessEpoch + 1 } :
                        {}),
                };
            });
        },
        nearnessEpoch: 0,
        reapplyNearness: (): void => {
            set((state) => {
                if (state.ordering?.kind !== "nearness") {
                    return state;
                }
                return { nearnessEpoch: state.nearnessEpoch + 1 };
            });
        },
        reconcileMediaShuffle: (fileIds: readonly number[]): void => {
            set((state) => {
                const { ordering } = state;
                if (ordering?.kind !== "shuffled") {
                    return state;
                }
                const nextIds = reconcileShuffledIds(
                    fileIds,
                    ordering.seed,
                    ordering.fileIds.length > 0 ? ordering.fileIds : undefined,
                );
                if (
                    nextIds.length === ordering.fileIds.length &&
                    nextIds.every((id, index) => id === ordering.fileIds[index])
                ) {
                    return state;
                }
                return { ordering: { ...ordering, fileIds: nextIds } };
            });
        },
        substituteMediaShuffleFileId: (oldId: number, newId: number): void => {
            set((state) => {
                const { ordering } = state;
                if (ordering?.kind !== "shuffled") {
                    return state;
                }
                const index = ordering.fileIds.indexOf(oldId);
                if (index === -1) {
                    return state;
                }
                const next = [...ordering.fileIds];
                next[index] = newId;
                return { ordering: { ...ordering, fileIds: next } };
            });
        },
    };
});

registerReset(() => {
    useUploadJobStore.getState().reset();
    useUIStore.setState({ ordering: undefined });
});
