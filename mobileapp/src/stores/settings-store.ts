import { create } from "zustand";
import type { StateCreator } from "zustand";
import {
    appSettingsFromOrganizerConfig,
    defaultAppSettings,
    mergeAppSettings,
    type PersistedAppSettings,
} from "@/lib/app-settings";
import type { OrganizerAppConfig } from "@/lib/organizer-config";
import { enqueueOrganizerConfigPatch } from "@/lib/organizer-config-save-queue";
import { useVideoPlaybackStore } from "@/stores/video-playback-store";

interface SettingsState extends PersistedAppSettings {
    hydrateFromOrganizerConfig: (config: OrganizerAppConfig | undefined) => void;
    patchSettings: (patch: Partial<PersistedAppSettings>) => void;
    reset: () => void;
}

const persistSettings = (settings: PersistedAppSettings): void => {
    enqueueOrganizerConfigPatch({ appSettings: settings });
};

const createSettingsStore: StateCreator<SettingsState> = (set, get) => ({
    ...defaultAppSettings(),

    hydrateFromOrganizerConfig: (config: OrganizerAppConfig | undefined): void => {
        const settings = appSettingsFromOrganizerConfig(config);
        set(settings);
        useVideoPlaybackStore.getState().applyDefaultMuted(settings.videoDefaultMuted);
    },

    patchSettings: (patch: Partial<PersistedAppSettings>): void => {
        const next = mergeAppSettings(get(), patch);
        set(next);
        persistSettings(next);
        if (patch.videoDefaultMuted !== undefined) {
            useVideoPlaybackStore.getState().applyDefaultMuted(next.videoDefaultMuted);
        }
    },

    reset: (): void => {
        set(defaultAppSettings());
    },
});

export const useSettingsStore = create<SettingsState>(createSettingsStore);
