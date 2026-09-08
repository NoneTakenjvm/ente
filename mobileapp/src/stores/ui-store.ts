import { create } from "zustand";
import type { StateCreator } from "zustand";
import { reconcileShuffledIds } from "@/lib/shuffle-files";
import type { ImageSizeSort } from "@/lib/image-size-sort";
import type { RelativeSort } from "@/lib/relative-sort";
import type { TagFilterFitSort } from "@/lib/tag-filter-fit-sort";
import type { TagFilterSelection } from "@/lib/tags";
import type { ViewportFitSort } from "@/lib/viewport-fit";

export type MediaViewOrder = "default" | "shuffled";

/** How the active nearness sort was entered (kit picker vs custom filter). */
export type NearnessSource = "kit" | "filter";

export type BackgroundJobStatus =
    | "idle" |
    "running" |
    "paused" |
    "done" |
    "error";

interface PhashJobState {
    status: BackgroundJobStatus;
    progress: { current: number; total: number };
    error: string | undefined;
    setStatus: (status: BackgroundJobStatus) => void;
    setProgress: (current: number, total: number) => void;
    setError: (error: string | undefined) => void;
    reset: () => void;
}

const initialPhashJob: Pick<
    PhashJobState,
    "status" | "progress" | "error"
> = {
    status: "idle",
    progress: { current: 0, total: 0 },
    error: undefined,
};

const createPhashJobStore: StateCreator<PhashJobState> = (set) => ({
    ...initialPhashJob,

    setStatus: (status: BackgroundJobStatus): void => {
        set({ status });
    },

    setProgress: (current: number, total: number): void => {
        set({ progress: { current, total } });
    },

    setError: (error: string | undefined): void => {
        set({ error });
    },

    reset: (): void => {
        set(initialPhashJob);
    },
});

export const usePhashJobStore = create<PhashJobState>(createPhashJobStore);

interface CompressJobState {
    status: BackgroundJobStatus;
    progress: { current: number; total: number };
    error: string | undefined;
    setStatus: (status: BackgroundJobStatus) => void;
    setProgress: (current: number, total: number) => void;
    setError: (error: string | undefined) => void;
    reset: () => void;
}

const initialCompressJob: Pick<
    CompressJobState,
    "status" | "progress" | "error"
> = {
    status: "idle",
    progress: { current: 0, total: 0 },
    error: undefined,
};

export const useCompressJobStore = create<CompressJobState>((set) => ({
    ...initialCompressJob,
    setStatus: (status: BackgroundJobStatus): void => {
        set({ status });
    },
    setProgress: (current: number, total: number): void => {
        set({ progress: { current, total } });
    },
    setError: (error: string | undefined): void => {
        set({ error });
    },
    reset: (): void => {
        set(initialCompressJob);
    },
}));

interface UploadJobState {
    status: BackgroundJobStatus;
    progress: { current: number; total: number };
    panelOpen: boolean;
    cancelRequested: boolean;
    setStatus: (status: BackgroundJobStatus) => void;
    setProgress: (current: number, total: number) => void;
    setPanelOpen: (open: boolean) => void;
    requestCancel: () => void;
    resetJob: () => void;
    reset: () => void;
}

const initialUploadJob: Pick<
    UploadJobState,
    "status" | "progress" | "panelOpen" | "cancelRequested"
> = {
    status: "idle",
    progress: { current: 0, total: 0 },
    panelOpen: false,
    cancelRequested: false,
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
    requestCancel: (): void => {
        set({ cancelRequested: true });
    },
    resetJob: (): void => {
        set((state) => ({
            status: "idle",
            progress: { current: 0, total: 0 },
            cancelRequested: false,
            panelOpen: state.panelOpen,
        }));
    },
    reset: (): void => {
        set(initialUploadJob);
    },
}));

interface UIState {
    dedupDryRun: boolean;
    setDedupDryRun: (value: boolean) => void;
    mediaViewOrder: MediaViewOrder;
    mediaShuffleSeed: number;
    mediaShuffledFileIds: number[];
    /** Gallery reorder by viewer viewport fit (session-only; device-specific). */
    viewportFitSort: ViewportFitSort;
    setViewportFitSort: (mode: ViewportFitSort) => void;
    /** Gallery reorder by pixel area (session-only). */
    imageSizeSort: ImageSizeSort;
    setImageSizeSort: (mode: ImageSizeSort) => void;
    /**
     * Gallery reorder by CLIP fit to the active tag filter (session-only).
     * Requires tag clauses; mutually exclusive with fit/size/nearness/relative/shuffle.
     */
    tagFilterFitSort: TagFilterFitSort;
    setTagFilterFitSort: (mode: TagFilterFitSort) => void;
    /**
     * Gallery reorder by greedy CLIP nearest/farthest-neighbor chain
     * (session-only). Mutually exclusive with fit/size/tag-filter-fit/nearness/shuffle.
     */
    relativeSort: RelativeSort;
    /** Seed for the random first tip when relative sort is active. */
    relativeSeed: number;
    setRelativeSort: (mode: RelativeSort) => void;
    /** Pick a new random start and rebuild the relative chain. */
    reapplyRelativeSort: () => void;
    /**
     * Gallery reorder by CLIP nearness to seeds matching this filter.
     * `undefined` = off. Session-only; independent of the main gallery filter;
     * mutually exclusive with fit/size/tag-filter-fit/relative/shuffle.
     */
    nearnessFilter: TagFilterSelection | undefined;
    /**
     * Whether nearness was set from Kit likeness or Filter nearness.
     * Cleared with the filter. Drives which Sort panel shows as active.
     */
    nearnessSource: NearnessSource | undefined;
    /**
     * When kit likeness is on, soft-penalize files closer to other kits.
     * Session-only; ignored for Filter nearness. Default on.
     */
    kitLikenessRivalPenalty: boolean;
    setKitLikenessRivalPenalty: (enabled: boolean) => void;
    /**
     * Bumped whenever nearness is (re)applied so the gallery can snapshot
     * order once — library/tag edits must not rebuild until reapply.
     */
    nearnessEpoch: number;
    setNearnessFilter: (
        filter: TagFilterSelection | undefined,
        source?: NearnessSource,
    ) => void;
    /** Rebuild nearness order from the current library (same filter). */
    reapplyNearness: () => void;
    setMediaShuffled: (seed: number) => void;
    setMediaDefaultOrder: () => void;
    reshuffleMedia: () => void;
    reconcileMediaShuffle: (fileIds: readonly number[]) => void;
    substituteMediaShuffleFileId: (oldId: number, newId: number) => void;
}

export const useUIStore = create<UIState>((set) => ({
    dedupDryRun: false,
    setDedupDryRun: (value: boolean): void => {
        set({ dedupDryRun: value });
    },
    mediaViewOrder: "default",
    mediaShuffleSeed: 1,
    mediaShuffledFileIds: [],
    viewportFitSort: "none",
    setViewportFitSort: (mode: ViewportFitSort): void => {
        set((state) => ({
            viewportFitSort: mode,
            ...(mode !== "none" ?
                {
                    imageSizeSort: "none" as const,
                    tagFilterFitSort: "none" as const,
                    relativeSort: "none" as const,
                    nearnessFilter: undefined,
                    nearnessSource: undefined,
                    ...(state.mediaViewOrder === "shuffled" ?
                        {
                            mediaViewOrder: "default" as const,
                            mediaShuffledFileIds: [] as number[],
                        } :
                        {}),
                } :
                {}),
        }));
    },
    imageSizeSort: "none",
    setImageSizeSort: (mode: ImageSizeSort): void => {
        set((state) => ({
            imageSizeSort: mode,
            ...(mode !== "none" ?
                {
                    viewportFitSort: "none" as const,
                    tagFilterFitSort: "none" as const,
                    relativeSort: "none" as const,
                    nearnessFilter: undefined,
                    nearnessSource: undefined,
                    ...(state.mediaViewOrder === "shuffled" ?
                        {
                            mediaViewOrder: "default" as const,
                            mediaShuffledFileIds: [] as number[],
                        } :
                        {}),
                } :
                {}),
        }));
    },
    tagFilterFitSort: "none",
    setTagFilterFitSort: (mode: TagFilterFitSort): void => {
        set((state) => ({
            tagFilterFitSort: mode,
            ...(mode !== "none" ?
                {
                    viewportFitSort: "none" as const,
                    imageSizeSort: "none" as const,
                    relativeSort: "none" as const,
                    nearnessFilter: undefined,
                    nearnessSource: undefined,
                    ...(state.mediaViewOrder === "shuffled" ?
                        {
                            mediaViewOrder: "default" as const,
                            mediaShuffledFileIds: [] as number[],
                        } :
                        {}),
                } :
                {}),
        }));
    },
    relativeSort: "none",
    relativeSeed: 1,
    setRelativeSort: (mode: RelativeSort): void => {
        set((state) => ({
            relativeSort: mode,
            ...(mode !== "none" ?
                {
                    // New random tip only when turning relative on from off.
                    relativeSeed:
                        state.relativeSort === "none" ?
                            Date.now() :
                            state.relativeSeed,
                    viewportFitSort: "none" as const,
                    imageSizeSort: "none" as const,
                    tagFilterFitSort: "none" as const,
                    nearnessFilter: undefined,
                    nearnessSource: undefined,
                    ...(state.mediaViewOrder === "shuffled" ?
                        {
                            mediaViewOrder: "default" as const,
                            mediaShuffledFileIds: [] as number[],
                        } :
                        {}),
                } :
                {}),
        }));
    },
    reapplyRelativeSort: (): void => {
        set((state) => {
            if (state.relativeSort === "none") {
                return state;
            }
            return { relativeSeed: Date.now() };
        });
    },
    nearnessFilter: undefined,
    nearnessSource: undefined,
    kitLikenessRivalPenalty: true,
    setKitLikenessRivalPenalty: (enabled: boolean): void => {
        set((state) => ({
            kitLikenessRivalPenalty: enabled,
            // Rebuild frozen kit-likeness order when the toggle changes.
            ...(state.nearnessSource === "kit" && state.nearnessFilter ?
                { nearnessEpoch: state.nearnessEpoch + 1 } :
                {}),
        }));
    },
    nearnessEpoch: 0,
    setNearnessFilter: (
        filter: TagFilterSelection | undefined,
        source: NearnessSource = "filter",
    ): void => {
        set((state) => ({
            nearnessFilter: filter,
            nearnessSource: filter !== undefined ? source : undefined,
            ...(filter !== undefined ?
                {
                    nearnessEpoch: state.nearnessEpoch + 1,
                    viewportFitSort: "none" as const,
                    imageSizeSort: "none" as const,
                    tagFilterFitSort: "none" as const,
                    relativeSort: "none" as const,
                    ...(state.mediaViewOrder === "shuffled" ?
                        {
                            mediaViewOrder: "default" as const,
                            mediaShuffledFileIds: [] as number[],
                        } :
                        {}),
                } :
                {}),
        }));
    },
    reapplyNearness: (): void => {
        set((state) => {
            if (!state.nearnessFilter) {
                return state;
            }
            return { nearnessEpoch: state.nearnessEpoch + 1 };
        });
    },
    setMediaShuffled: (seed: number): void => {
        set({
            mediaViewOrder: "shuffled",
            mediaShuffleSeed: seed,
            mediaShuffledFileIds: [],
            viewportFitSort: "none",
            imageSizeSort: "none",
            tagFilterFitSort: "none",
            relativeSort: "none",
            nearnessFilter: undefined,
            nearnessSource: undefined,
        });
    },
    setMediaDefaultOrder: (): void => {
        set({ mediaViewOrder: "default", mediaShuffledFileIds: [] });
    },
    reshuffleMedia: (): void => {
        set({
            mediaViewOrder: "shuffled",
            mediaShuffleSeed: Date.now(),
            mediaShuffledFileIds: [],
            viewportFitSort: "none",
            imageSizeSort: "none",
            tagFilterFitSort: "none",
            relativeSort: "none",
            nearnessFilter: undefined,
            nearnessSource: undefined,
        });
    },
    reconcileMediaShuffle: (fileIds: readonly number[]): void => {
        set((state) => {
            if (state.mediaViewOrder !== "shuffled") {
                return state;
            }
            const nextIds = reconcileShuffledIds(
                fileIds,
                state.mediaShuffleSeed,
                state.mediaShuffledFileIds.length > 0 ?
                    state.mediaShuffledFileIds :
                    undefined,
            );
            if (
                nextIds.length === state.mediaShuffledFileIds.length &&
                nextIds.every((id, index) => id === state.mediaShuffledFileIds[index])
            ) {
                return state;
            }
            return { mediaShuffledFileIds: nextIds };
        });
    },
    substituteMediaShuffleFileId: (oldId: number, newId: number): void => {
        set((state) => {
            if (state.mediaViewOrder !== "shuffled") {
                return state;
            }
            const index = state.mediaShuffledFileIds.indexOf(oldId);
            if (index === -1) {
                return state;
            }
            const next = [...state.mediaShuffledFileIds];
            next[index] = newId;
            return { mediaShuffledFileIds: next };
        });
    },
}));
