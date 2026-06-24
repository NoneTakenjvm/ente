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
