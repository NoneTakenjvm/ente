import { create } from "zustand";

const VOLUME_KEY = "mobileapp-video-volume";

const readVolume = (): number => {
    if (typeof window === "undefined") {
        return 0;
    }
    try {
        const raw = localStorage.getItem(VOLUME_KEY);
        if (raw === null) {
            return 0;
        }
        const parsed = Number.parseFloat(raw);
        if (!Number.isFinite(parsed)) {
            return 0;
        }
        return Math.min(1, Math.max(0, parsed));
    } catch {
        return 0;
    }
};

const persistVolume = (volume: number): void => {
    try {
        localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {
        // Ignore quota errors.
    }
};

interface VideoPlaybackState {
    volume: number;
    muted: boolean;
    hydrated: boolean;
    hydrate: () => void;
    applyDefaultMuted: (muted: boolean) => void;
    setVolume: (volume: number) => void;
    setMuted: (muted: boolean) => void;
    toggleMuted: () => void;
}

export const useVideoPlaybackStore = create<VideoPlaybackState>((set, get) => ({
    volume: 0,
    muted: true,
    hydrated: false,

    hydrate: (): void => {
        if (get().hydrated) {
            return;
        }
        set({
            volume: readVolume(),
            hydrated: true,
        });
    },

    applyDefaultMuted: (muted: boolean): void => {
        set({ muted });
    },

    setVolume: (volume: number): void => {
        const clamped = Math.min(1, Math.max(0, volume));
        persistVolume(clamped);
        const updates: Partial<VideoPlaybackState> = { volume: clamped };
        if (clamped > 0) {
            updates.muted = false;
        } else {
            updates.muted = true;
        }
        set(updates);
    },

    setMuted: (muted: boolean): void => {
        set({ muted });
    },

    toggleMuted: (): void => {
        const next = !get().muted;
        if (!next && get().volume === 0) {
            persistVolume(1);
            set({ muted: next, volume: 1 });
            return;
        }
        set({ muted: next });
    },
}));
