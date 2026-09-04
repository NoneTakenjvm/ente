import { create } from "zustand";
import type { StateCreator } from "zustand";
import { reconcileShuffledIds } from "@/lib/shuffle-files";
import type { ImageSizeSort } from "@/lib/image-size-sort";
import type { ViewportFitSort } from "@/lib/viewport-fit";

export type MediaViewOrder = "default" | "shuffled";

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
     * Gallery reorder by visual nearness to a tag kit (preset id).
     * `undefined` = off. Session-only; mutually exclusive with fit/size/shuffle.
     */
    kitNearnessPresetId: string | undefined;
    /**
     * Bumped whenever kit nearness is (re)applied so the gallery can snapshot
     * medoids once — tagging more kit members must not rebuild until reapply.
     */
    kitNearnessEpoch: number;
    setKitNearnessPresetId: (presetId: string | undefined) => void;
    /** Rebuild kit nearness medoids from the current library (same kit). */
    reapplyKitNearness: () => void;
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
                    kitNearnessPresetId: undefined,
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
                    kitNearnessPresetId: undefined,
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
    kitNearnessPresetId: undefined,
    kitNearnessEpoch: 0,
    setKitNearnessPresetId: (presetId: string | undefined): void => {
        set((state) => ({
            kitNearnessPresetId: presetId,
            ...(presetId !== undefined ?
                {
                    kitNearnessEpoch: state.kitNearnessEpoch + 1,
                    viewportFitSort: "none" as const,
                    imageSizeSort: "none" as const,
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
    reapplyKitNearness: (): void => {
        set((state) => {
            if (!state.kitNearnessPresetId) {
                return state;
            }
            return { kitNearnessEpoch: state.kitNearnessEpoch + 1 };
        });
    },
    setMediaShuffled: (seed: number): void => {
        set({
            mediaViewOrder: "shuffled",
            mediaShuffleSeed: seed,
            mediaShuffledFileIds: [],
            viewportFitSort: "none",
            imageSizeSort: "none",
            kitNearnessPresetId: undefined,
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
            kitNearnessPresetId: undefined,
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
