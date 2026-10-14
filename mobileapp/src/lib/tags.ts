import type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
import type { EnteFile } from "ente-media/file";
import { getPublicMetadata } from "@/core/metadata";
import type { PersistedTagIndex } from "@/db/kv";

export interface OrganizerTagMetadata {
    tags?: string[];
    updatedAt?: number;
}

const SYSTEM_TAGS = new Set([
    "compressed",
    "rotated",
    "cropped",
    "auto-cropped",
]);

/**
 * Return true when the tag is reserved for internal organizer workflows.
 */
export const isSystemTag = (tag: string): boolean => SYSTEM_TAGS.has(tag);

/**
 * Read organizer tags from public magic metadata (`_organizer_v1.tags`).
 */
export const extractTags = (file: EnteFile): string[] => {
    const data = getPublicMetadata(file) as FilePublicMagicMetadataData &
        { _organizer_v1?: OrganizerTagMetadata };
    const tags = data._organizer_v1?.tags;
    if (!tags?.length) {
        return [];
    }
    return tags.filter((tag) => typeof tag === "string" && tag.length > 0);
};

/**
 * Return true when the file was cropped by the user (not only by auto-crop).
 *
 * Manual crop stamps `cropped`; auto-crop stamps both `cropped` and
 * `auto-cropped`. Files only marked `auto-cropped` (scanned, no border) are
 * not manually cropped.
 */
export const isManuallyCroppedFile = (file: EnteFile): boolean => {
    const tags = extractTags(file);
    return tags.includes("cropped") && !tags.includes("auto-cropped");
};

/**
 * Return true when the file was rotated in this app (stamps the `rotated` tag).
 */
export const isManuallyRotatedFile = (file: EnteFile): boolean =>
    extractTags(file).includes("rotated");

/**
 * User-visible organizer tags (excludes internal system tags).
 */
export const extractUserTags = (file: EnteFile): string[] =>
    extractTags(file).filter((tag) => !isSystemTag(tag));

/**
 * Build a tag index from decrypted files.
 */
export const buildTagIndex = (files: EnteFile[]): PersistedTagIndex => {
    const fileIdsByTag: Record<string, number[]> = {};
    const tagSet = new Set<string>();

    for (const file of files) {
        for (const tag of extractUserTags(file)) {
            tagSet.add(tag);
            const list = fileIdsByTag[tag] ?? [];
            list.push(file.id);
            fileIdsByTag[tag] = list;
        }
    }

    return {
        tags: [...tagSet].sort(),
        fileIdsByTag,
    };
};

export const tagIndexToMaps = (
    index: PersistedTagIndex,
): {
    tags: string[];
    fileIdsByTag: Map<string, Set<number>>;
} => {
    const fileIdsByTag = new Map<string, Set<number>>();
    for (const tag of index.tags) {
        fileIdsByTag.set(tag, new Set(index.fileIdsByTag[tag] ?? []));
    }
    return { tags: index.tags, fileIdsByTag };
};

/** Number of files tagged with a given name. */
export const tagFileCount = (
    tag: string,
    fileIdsByTag: Map<string, Set<number>>,
): number => fileIdsByTag.get(tag)?.size ?? 0;
