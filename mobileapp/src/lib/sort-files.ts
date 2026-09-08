import type { EnteFile } from "ente-media/file";
import { fileCreationTime } from "ente-media/file-metadata";

/**
 * Sort key by the file's first upload time, newest first.
 *
 * Prefers the `uploadedAt` recorded in public magic metadata (stamped by this
 * app on upload and preserved across derived reuploads), falls back to
 * `updationTime` for legacy files uploaded elsewhere, then to the capture date.
 */
export const fileUploadSortTime = (file: EnteFile): number =>
    file.pubMagicMetadata?.data.uploadedAt ??
    file.updationTime ??
    fileCreationTime(file);

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
): EnteFile[] => [...files].sort((a, b) => key(b) - key(a));

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
