import type { OrganizerAppConfig } from "@/lib/organizer-config";

export type MediaSortBy = "uploaded" | "edited";

export type GalleryThumbnailMode = "grid" | "fit";

export type GalleryColumnCount = 2 | 3 | 4 | 5 | 6;

export interface PersistedAppSettings {
    videoAutoPlay: boolean;
    videoLoop: boolean;
    videoDefaultMuted: boolean;
    galleryColumns: GalleryColumnCount;
    galleryThumbnailMode: GalleryThumbnailMode;
    gallerySortBy: MediaSortBy;
}

export const defaultAppSettings = (): PersistedAppSettings => ({
    videoAutoPlay: true,
    videoLoop: true,
    videoDefaultMuted: true,
    galleryColumns: 4,
    galleryThumbnailMode: "grid",
    gallerySortBy: "uploaded",
});

export const mergeAppSettings = (
    current: PersistedAppSettings | undefined,
    patch: Partial<PersistedAppSettings>,
): PersistedAppSettings => ({
    ...defaultAppSettings(),
    ...current,
    ...patch,
});

export const appSettingsFromOrganizerConfig = (
    config: OrganizerAppConfig | undefined,
): PersistedAppSettings => mergeAppSettings(config?.appSettings, {});
