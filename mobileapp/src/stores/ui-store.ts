import { create } from "zustand";
import type { StateCreator } from "zustand";
import { reconcileShuffledIds } from "@/lib/shuffle-files";
import type { ImageQualitySort } from "@/lib/image-quality";
import type { ImageSizeSort } from "@/lib/image-size-sort";
import type { RelativeSort } from "@/lib/relative-sort";
import type { TagFilterFitSort } from "@/lib/tag-filter-fit-sort";
import type { TagFilterSelection } from "@/lib/tags";
import type { UpdatedAtSort } from "@/lib/updated-at-sort";
import {
    deviceViewerSize,
    type ViewportFitSort,
} from "@/lib/viewport-fit";

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
    progress: {
        current: number;
        total: number;
        stage: string;
        fileLabel: string;
        ratio: number | undefined;
        encoder: string | undefined;
    };
    error: string | undefined;
    setStatus: (status: BackgroundJobStatus) => void;
    setProgress: (update: {
        current: number;
        total: number;
        stage?: string;
        fileLabel?: string;
        ratio?: number;
        encoder?: string;
    }) => void;
    setError: (error: string | undefined) => void;
    reset: () => void;
}

const initialCompressJob: Pick<
    CompressJobState,
    "status" | "progress" | "error"
> = {
    status: "idle",
    progress: {
        current: 0,
        total: 0,
        stage: "",
        fileLabel: "",
        ratio: undefined,
        encoder: undefined,
    },
    error: undefined,
};

export const useCompressJobStore = create<CompressJobState>((set) => ({
    ...initialCompressJob,
    setStatus: (status: BackgroundJobStatus): void => {
        set({ status });
    },
    setProgress: (update): void => {
        set({
            progress: {
                current: update.current,
                total: update.total,
                stage: update.stage ?? "",
                fileLabel: update.fileLabel ?? "",
                ratio: update.ratio,
                encoder: update.encoder,
            },
        });
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
    /**
     * Target viewport size (CSS px) for fit sort + crop defaults (session-only).
     * Initialized once from the live device; not updated on rotate/resize.
     */
    viewportTargetWidth: number;
    viewportTargetHeight: number;
    setViewportTargetSize: (width: number, height: number) => void;
    /** Re-fill target W×H from the current live device viewport. */
    resetViewportTargetToDevice: () => void;
    /** Gallery reorder by last update time (session-only). */
    updatedAtSort: UpdatedAtSort;
    setUpdatedAtSort: (mode: UpdatedAtSort) => void;
    /** Gallery reorder by pixel area (session-only). */
    imageSizeSort: ImageSizeSort;
    setImageSizeSort: (mode: ImageSizeSort) => void;
    /** Gallery reorder by persisted image quality score (session-only). */
    imageQualitySort: ImageQualitySort;
    setImageQualitySort: (mode: ImageQualitySort) => void;
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
    /**
     * Explicit chain tip (from viewer "Set Relative"). When set and still in
     * the filtered set, overrides {@link relativeSeed}. Cleared by New start.
     */
    relativeStartFileId: number | undefined;
    setRelativeSort: (mode: RelativeSort) => void;
    /** Pin the relative snake tip to this file id (requires relative sort on). */
    setRelativeStartFileId: (fileId: number) => void;
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

export const useUIStore = create<UIState>((set) => {
    const initialViewportTarget = deviceViewerSize();
    return {
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
                        updatedAtSort: "none" as const,
                        imageSizeSort: "none" as const,
                        imageQualitySort: "none" as const,
                        tagFilterFitSort: "none" as const,
                        relativeSort: "none" as const,
                        relativeStartFileId: undefined,
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
        updatedAtSort: "none",
        setUpdatedAtSort: (mode: UpdatedAtSort): void => {
            set((state) => ({
                updatedAtSort: mode,
                ...(mode !== "none" ?
                    {
                        viewportFitSort: "none" as const,
                        imageSizeSort: "none" as const,
                        imageQualitySort: "none" as const,
                        tagFilterFitSort: "none" as const,
                        relativeSort: "none" as const,
                        relativeStartFileId: undefined,
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
                        updatedAtSort: "none" as const,
                        imageQualitySort: "none" as const,
                        tagFilterFitSort: "none" as const,
                        relativeSort: "none" as const,
                        relativeStartFileId: undefined,
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
        imageQualitySort: "none",
        setImageQualitySort: (mode: ImageQualitySort): void => {
            set((state) => ({
                imageQualitySort: mode,
                ...(mode !== "none" ?
                    {
                        viewportFitSort: "none" as const,
                        updatedAtSort: "none" as const,
                        imageSizeSort: "none" as const,
                        tagFilterFitSort: "none" as const,
                        relativeSort: "none" as const,
                        relativeStartFileId: undefined,
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
                        updatedAtSort: "none" as const,
                        imageSizeSort: "none" as const,
                        imageQualitySort: "none" as const,
                        relativeSort: "none" as const,
                        relativeStartFileId: undefined,
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
        relativeStartFileId: undefined,
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
                        relativeStartFileId:
                        state.relativeSort === "none" ?
                            undefined :
                            state.relativeStartFileId,
                        viewportFitSort: "none" as const,
                        updatedAtSort: "none" as const,
                        imageSizeSort: "none" as const,
                        imageQualitySort: "none" as const,
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
                    { relativeStartFileId: undefined }),
            }));
        },
        setRelativeStartFileId: (fileId: number): void => {
            set((state) => {
                if (state.relativeSort === "none") {
                    return state;
                }
                return { relativeStartFileId: fileId };
            });
        },
        reapplyRelativeSort: (): void => {
            set((state) => {
                if (state.relativeSort === "none") {
                    return state;
                }
                return {
                    relativeSeed: Date.now(),
                    relativeStartFileId: undefined,
                };
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
                    ...(state.nearnessSource === "kit" &&
                    state.nearnessFilter &&
                    state.kitLikenessRivalPenalty ?
                        { nearnessEpoch: state.nearnessEpoch + 1 } :
                        {}),
                };
            });
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
                        updatedAtSort: "none" as const,
                        imageSizeSort: "none" as const,
                        imageQualitySort: "none" as const,
                        tagFilterFitSort: "none" as const,
                        relativeSort: "none" as const,
                        relativeStartFileId: undefined,
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
                updatedAtSort: "none",
                imageSizeSort: "none",
                imageQualitySort: "none",
                tagFilterFitSort: "none",
                relativeSort: "none",
                relativeStartFileId: undefined,
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
                updatedAtSort: "none",
                imageSizeSort: "none",
                imageQualitySort: "none",
                tagFilterFitSort: "none",
                relativeSort: "none",
                relativeStartFileId: undefined,
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
    };
});
