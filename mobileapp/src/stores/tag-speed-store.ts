import { create } from "zustand";
import { enqueueOrganizerConfigPatch } from "@/lib/organizer-config-save-queue";
import {
    normalizeTagNameList,
    pushRecentTags,
    type TagBulkUndoEntry,
} from "@/lib/tag-bulk";
import {
    newTagPresetId,
    normalizePresetName,
    normalizePresetTags,
    presetsFromPersisted,
    presetsToPersisted,
    type PersistedTagPresets,
    type TagPreset,
} from "@/lib/tag-presets";
import type { KitNearnessTuneResult } from "@/lib/kit-nearness-embedding-genome";

const MAX_RECENT_TAGS = 12;
const MAX_PINNED_TAGS = 16;

interface TagSpeedState {
    presets: TagPreset[];
    pinnedTags: string[];
    recentTags: string[];
    lastBulkUndo: TagBulkUndoEntry[] | undefined;
    hydrateFromOrganizerConfig: (input: {
        tagPresets?: PersistedTagPresets;
        pinnedTags?: string[];
    }) => void;
    addPreset: (name: string, tags: string[]) => TagPreset | undefined;
    updatePreset: (
        id: string,
        patch: {
            name?: string;
            tags?: string[];
            nearnessTune?: KitNearnessTuneResult | null;
        },
    ) => void;
    deletePreset: (id: string) => void;
    setPinnedTags: (tags: string[]) => void;
    togglePinnedTag: (tag: string) => void;
    recordRecentTags: (tags: string[]) => void;
    setLastBulkUndo: (entries: TagBulkUndoEntry[] | undefined) => void;
    clearLastBulkUndo: () => void;
    reset: () => void;
}

const initialState: Pick<
    TagSpeedState,
    "presets" | "pinnedTags" | "recentTags" | "lastBulkUndo"
> = {
    presets: [],
    pinnedTags: [],
    recentTags: [],
    lastBulkUndo: undefined,
};

const persistPresets = (presets: TagPreset[]): void => {
    enqueueOrganizerConfigPatch({
        tagPresets: presetsToPersisted(presets),
    });
};

const persistPinned = (pinnedTags: string[]): void => {
    enqueueOrganizerConfigPatch({ pinnedTags });
};

export const useTagSpeedStore = create<TagSpeedState>((set, get) => ({
    ...initialState,

    hydrateFromOrganizerConfig: (input): void => {
        set({
            presets: presetsFromPersisted(input.tagPresets),
            pinnedTags: normalizeTagNameList(
                input.pinnedTags ?? [],
                MAX_PINNED_TAGS,
            ),
        });
    },

    addPreset: (name, tags): TagPreset | undefined => {
        const normalizedName = normalizePresetName(name);
        const normalizedTags = normalizePresetTags(tags);
        if (!normalizedName || normalizedTags.length === 0) {
            return undefined;
        }
        const preset: TagPreset = {
            id: newTagPresetId(),
            name: normalizedName,
            tags: normalizedTags,
        };
        const presets = [...get().presets, preset];
        set({ presets });
        persistPresets(presets);
        return preset;
    },

    updatePreset: (id, patch): void => {
        const presets = get().presets.map((preset) => {
            if (preset.id !== id) {
                return preset;
            }
            const name =
                patch.name !== undefined ?
                    (normalizePresetName(patch.name) ?? preset.name) :
                    preset.name;
            const tags =
                patch.tags !== undefined ?
                    normalizePresetTags(patch.tags) :
                    preset.tags;
            const next: TagPreset = { ...preset, name, tags };
            if (patch.nearnessTune === null) {
                delete next.nearnessTune;
            } else if (patch.nearnessTune !== undefined) {
                next.nearnessTune = patch.nearnessTune;
            }
            return next;
        }).filter((preset) => preset.tags.length > 0);
        set({ presets });
        persistPresets(presets);
    },

    deletePreset: (id): void => {
        const presets = get().presets.filter((preset) => preset.id !== id);
        set({ presets });
        persistPresets(presets);
    },

    setPinnedTags: (tags): void => {
        const pinnedTags = normalizeTagNameList(tags, MAX_PINNED_TAGS);
        set({ pinnedTags });
        persistPinned(pinnedTags);
    },

    togglePinnedTag: (tag): void => {
        const trimmed = tag.trim();
        if (!trimmed) {
            return;
        }
        const current = get().pinnedTags;
        const pinnedTags = current.includes(trimmed) ?
            current.filter((entry) => entry !== trimmed) :
            normalizeTagNameList([trimmed, ...current], MAX_PINNED_TAGS);
        set({ pinnedTags });
        persistPinned(pinnedTags);
    },

    recordRecentTags: (tags): void => {
        set({
            recentTags: pushRecentTags(get().recentTags, tags, MAX_RECENT_TAGS),
        });
    },

    setLastBulkUndo: (entries): void => {
        set({ lastBulkUndo: entries });
    },

    clearLastBulkUndo: (): void => {
        set({ lastBulkUndo: undefined });
    },

    reset: (): void => {
        set(initialState);
    },
}));
