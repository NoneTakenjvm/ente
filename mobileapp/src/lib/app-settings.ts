import type { OrganizerAppConfig } from "@/lib/organizer-config";

export type MediaSortBy = "uploaded" | "edited";

const isMediaSortBy = (value: unknown): value is MediaSortBy =>
    value === "uploaded" || value === "edited";

export type GalleryThumbnailMode = "grid" | "fit";

export type GalleryColumnCount = 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const MIN_GALLERY_COLUMNS = 2;
export const MAX_GALLERY_COLUMNS = 8;

/** Default Similar-photos group cap (true duplicates rarely exceed a handful). */
export const DEFAULT_SIMILAR_MAX_GROUP_SIZE = 5;
export const MIN_SIMILAR_MAX_GROUP_SIZE = 1;
export const MAX_SIMILAR_MAX_GROUP_SIZE = 5;

/**
 * CLIP ORT batch size. {@link CLIP_EMBEDDING_BATCH_SIZE_AUTO} uses device
 * defaults (WebGPU 2 mobile / 6 desktop; WASM 1 / 2). Explicit picks are from
 * {@link CLIP_EMBEDDING_BATCH_SIZE_OPTIONS}.
 */
export const CLIP_EMBEDDING_BATCH_SIZE_AUTO = 0;
export const CLIP_EMBEDDING_BATCH_SIZE_OPTIONS = [4, 8, 12, 16] as const;
export type ClipEmbeddingBatchSizeOption =
    (typeof CLIP_EMBEDDING_BATCH_SIZE_OPTIONS)[number];

export interface PersistedAppSettings {
    videoAutoPlay: boolean;
    videoLoop: boolean;
    videoDefaultMuted: boolean;
    galleryColumns: GalleryColumnCount;
    galleryThumbnailMode: GalleryThumbnailMode;
    gallerySortBy: MediaSortBy;
    /** Cap: hide Similar groups larger than this (matching stays uncapped). */
    similarMaxGroupSize: number;
    /**
     * Images per CLIP ORT forward. {@link CLIP_EMBEDDING_BATCH_SIZE_AUTO} =
     * device default; otherwise one of {@link CLIP_EMBEDDING_BATCH_SIZE_OPTIONS}.
     */
    clipEmbeddingBatchSize: number;
}

/**
 * Clamp a gallery column count into the allowed settings range.
 */
export const clampGalleryColumns = (value: number): GalleryColumnCount => {
    if (!Number.isFinite(value)) {
        return 4;
    }
    return Math.min(
        MAX_GALLERY_COLUMNS,
        Math.max(MIN_GALLERY_COLUMNS, Math.round(value)),
    ) as GalleryColumnCount;
};

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

/**
 * Clamp CLIP batch size: Auto (0) or nearest of 4 / 8 / 12 / 16. Invalid → Auto.
 */
export const clampClipEmbeddingBatchSize = (value: number): number => {
    if (!Number.isFinite(value)) {
        return CLIP_EMBEDDING_BATCH_SIZE_AUTO;
    }
    const rounded = Math.round(value);
    if (rounded <= CLIP_EMBEDDING_BATCH_SIZE_AUTO) {
        return CLIP_EMBEDDING_BATCH_SIZE_AUTO;
    }
    let best: ClipEmbeddingBatchSizeOption = CLIP_EMBEDDING_BATCH_SIZE_OPTIONS[0];
    let bestDist = Math.abs(rounded - best);
    for (const option of CLIP_EMBEDDING_BATCH_SIZE_OPTIONS) {
        const dist = Math.abs(rounded - option);
        if (dist < bestDist) {
            best = option;
            bestDist = dist;
        }
    }
    return best;
};

export const defaultAppSettings = (): PersistedAppSettings => ({
    videoAutoPlay: true,
    videoLoop: true,
    videoDefaultMuted: true,
    galleryColumns: 4,
    galleryThumbnailMode: "grid",
    gallerySortBy: "uploaded",
    similarMaxGroupSize: DEFAULT_SIMILAR_MAX_GROUP_SIZE,
    clipEmbeddingBatchSize: CLIP_EMBEDDING_BATCH_SIZE_AUTO,
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
        galleryColumns: clampGalleryColumns(merged.galleryColumns),
        gallerySortBy: isMediaSortBy(merged.gallerySortBy) ?
            merged.gallerySortBy :
            "uploaded",
        similarMaxGroupSize: clampSimilarMaxGroupSize(merged.similarMaxGroupSize),
        clipEmbeddingBatchSize: clampClipEmbeddingBatchSize(
            merged.clipEmbeddingBatchSize,
        ),
    };
};

export const appSettingsFromOrganizerConfig = (
    config: OrganizerAppConfig | undefined,
): PersistedAppSettings => mergeAppSettings(config?.appSettings, {});
