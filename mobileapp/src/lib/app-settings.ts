import type { OrganizerAppConfig } from "@/lib/organizer-config";

export type MediaSortBy = "uploaded" | "edited";

export type GalleryThumbnailMode = "grid" | "fit";

export type GalleryColumnCount = 2 | 3 | 4 | 5 | 6;

/** Default Similar-photos group cap (true duplicates rarely exceed a handful). */
export const DEFAULT_SIMILAR_MAX_GROUP_SIZE = 5;
export const MIN_SIMILAR_MAX_GROUP_SIZE = 1;
export const MAX_SIMILAR_MAX_GROUP_SIZE = 5;

export interface PersistedAppSettings {
    videoAutoPlay: boolean;
    videoLoop: boolean;
    videoDefaultMuted: boolean;
    galleryColumns: GalleryColumnCount;
    galleryThumbnailMode: GalleryThumbnailMode;
    gallerySortBy: MediaSortBy;
    /** Cap: hide Similar groups larger than this (matching stays uncapped). */
    similarMaxGroupSize: number;
}

/**
 * Clamp a Similar max-group-size value into the allowed settings range.
 */
export const clampSimilarMaxGroupSize = (value: number): number => {
    if (!Number.isFinite(value)) {
        return DEFAULT_SIMILAR_MAX_GROUP_SIZE;
    }
    return Math.min(
        MAX_SIMILAR_MAX_GROUP_SIZE,
        Math.max(MIN_SIMILAR_MAX_GROUP_SIZE, Math.round(value)),
    );
};

export const defaultAppSettings = (): PersistedAppSettings => ({
    videoAutoPlay: true,
    videoLoop: true,
    videoDefaultMuted: true,
    galleryColumns: 4,
    galleryThumbnailMode: "grid",
    gallerySortBy: "uploaded",
    similarMaxGroupSize: DEFAULT_SIMILAR_MAX_GROUP_SIZE,
});

export const mergeAppSettings = (
    current: PersistedAppSettings | undefined,
    patch: Partial<PersistedAppSettings>,
): PersistedAppSettings => {
    const merged = {
        ...defaultAppSettings(),
        ...current,
        ...patch,
    };
    return {
        ...merged,
        similarMaxGroupSize: clampSimilarMaxGroupSize(merged.similarMaxGroupSize),
    };
};

export const appSettingsFromOrganizerConfig = (
    config: OrganizerAppConfig | undefined,
): PersistedAppSettings => mergeAppSettings(config?.appSettings, {});
