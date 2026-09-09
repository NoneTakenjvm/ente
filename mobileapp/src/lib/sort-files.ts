import type { EnteFile } from "ente-media/file";
import { fileCreationTime } from "ente-media/file-metadata";
import type { OrganizerTagMetadata } from "@/lib/tags";

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

/**
 * Epoch µs when organizer tags were last written, if present.
 */
const organizerUpdatedAt = (file: EnteFile): number | undefined => {
    const data = file.pubMagicMetadata?.data as
        { _organizer_v1?: OrganizerTagMetadata } | undefined;
    const value = data?._organizer_v1?.updatedAt;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

/**
 * Sort key by the file's last update of any kind, newest first.
 *
 * Takes the newest among organizer tag `updatedAt`, public `editedAt`, and
 * server `updationTime` so tag stamps surface immediately without waiting for
 * a sync that refreshes `updationTime`.
 */
export const fileUpdateSortTime = (file: EnteFile): number => {
    const latest = Math.max(
        organizerUpdatedAt(file) ?? 0,
        file.pubMagicMetadata?.data.editedAt ?? 0,
        file.updationTime ?? 0,
    );
    return latest > 0 ?
        latest :
        (file.metadata.modificationTime ?? fileCreationTime(file));
};

const sortFilesNewestFirst = (
    files: EnteFile[],
    key: (file: EnteFile) => number,
): EnteFile[] => [...files].sort((a, b) => key(b) - key(a));

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
 * Pull {@link fileIds} to the front (newest update first), keep the rest.
 */
export const moveFilesToFrontByUpdate = (
    files: readonly EnteFile[],
    fileIds: readonly number[],
): EnteFile[] => {
    if (!fileIds.length) {
        return [...files];
    }
    const bring = new Set(fileIds);
    const head: EnteFile[] = [];
    const rest: EnteFile[] = [];
    for (const file of files) {
        if (bring.has(file.id)) {
            head.push(file);
        } else {
            rest.push(file);
        }
    }
    head.sort((a, b) => fileUpdateSortTime(b) - fileUpdateSortTime(a));
    return [...head, ...rest];
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

/**
 * Return a copy of {@link files} sorted newest-first by last update time.
 */
export const sortFilesByUpdate = (files: EnteFile[]): EnteFile[] =>
    sortFilesNewestFirst(files, fileUpdateSortTime);
