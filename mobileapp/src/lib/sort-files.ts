import type { EnteFile } from "ente-media/file";
import { fileCreationTime } from "ente-media/file-metadata";
import { fileUploadSortTime } from "@/core/metadata";

/**
 * Sort key by the file's last edit time, newest first.
 *
 * `editedAt` is bumped on non-tag public-metadata writes and derived
 * reuploads. Tag-only updates intentionally leave it alone so gallery
 * "edited" sort does not jump on every stamp. For legacy files without it,
 * falls back to the file's modification time, then its capture date.
 */
export const fileEditSortTime = (file: EnteFile): number =>
    file.pubMagicMetadata?.data.editedAt ??
    file.metadata.modificationTime ??
    fileCreationTime(file);

const sortFilesNewestFirst = (
    files: EnteFile[],
    key: (file: EnteFile) => number,
): EnteFile[] => [...files].sort((a, b) => key(b) - key(a) || b.id - a.id);

/**
 * Keep {@link previous} order when {@link nextVisible} is the same id set
 * with updated file objects. Returns undefined when membership changed.
 */
export const remapSortedFilesIfSameIds = (
    previous: readonly EnteFile[],
    nextVisible: readonly EnteFile[],
): EnteFile[] | undefined => {
    if (previous.length === 0 || previous.length !== nextVisible.length) {
        return undefined;
    }
    const byId = new Map(nextVisible.map((file) => [file.id, file]));
    const remapped: EnteFile[] = [];
    for (const file of previous) {
        const updated = byId.get(file.id);
        if (!updated) {
            return undefined;
        }
        remapped.push(updated);
    }
    return remapped;
};

/**
 * Return a copy of {@link files} sorted newest-first by upload time.
 */
export const sortFilesByUpload = (files: EnteFile[]): EnteFile[] =>
    sortFilesNewestFirst(files, fileUploadSortTime);

/**
 * Return a copy of {@link files} sorted newest-first by last edit time.
 */
export const sortFilesByEdit = (files: EnteFile[]): EnteFile[] =>
    sortFilesNewestFirst(files, fileEditSortTime);
