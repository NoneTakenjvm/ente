import { create } from "zustand";
import type { StateCreator } from "zustand";
import { reconcileShuffledIds } from "@/lib/shuffle-files";

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

interface UIState {
    dedupDryRun: boolean;
    setDedupDryRun: (value: boolean) => void;
    mediaViewOrder: MediaViewOrder;
    mediaShuffleSeed: number;
    mediaShuffledFileIds: number[];
    setMediaShuffled: (seed: number) => void;
    setMediaDefaultOrder: () => void;
    reshuffleMedia: () => void;
    reconcileMediaShuffle: (fileIds: readonly number[]) => void;
}

export const useUIStore = create<UIState>((set) => ({
    dedupDryRun: false,
    setDedupDryRun: (value: boolean): void => {
        set({ dedupDryRun: value });
    },
    mediaViewOrder: "default",
    mediaShuffleSeed: 1,
    mediaShuffledFileIds: [],
    setMediaShuffled: (seed: number): void => {
        set({
            mediaViewOrder: "shuffled",
            mediaShuffleSeed: seed,
            mediaShuffledFileIds: [],
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
}));
