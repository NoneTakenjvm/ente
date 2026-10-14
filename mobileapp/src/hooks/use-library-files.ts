import { useState } from "react";
import {
    remapSortedFilesIfSameIds,
    sortFilesByEdit,
    sortFilesByUpload,
} from "@/lib/sort-files";
import { dedupeFilesById } from "@/lib/sync/merge-files";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import { useLibraryStore } from "@/stores/library-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { EnteFile } from "ente-media/file";

/**
 * The deduped, non-archived library in the user's chosen sort order.
 *
 * Re-sorts only when membership or sort mode changes; a patch that keeps the
 * same ids (tag touch, version ack) reuses the previous order.
 */
export function useLibraryFiles(): EnteFile[] {
    const allFiles = useLibraryStore((s) => s.allFiles);
    const sortFiles = useSettingsStore((s) =>
        s.gallerySortBy === "edited" ? sortFilesByEdit : sortFilesByUpload);

    const [cache, setCache] = useState(() => ({
        source: allFiles,
        sortFiles,
        files: sortFiles(visibleLibraryFiles(allFiles)),
    }));
    if (cache.source === allFiles && cache.sortFiles === sortFiles) {
        return cache.files;
    }
    const visible = visibleLibraryFiles(allFiles);
    const files =
        (cache.sortFiles === sortFiles ?
            remapSortedFilesIfSameIds(cache.files, visible) :
            undefined) ?? sortFiles(visible);
    setCache({ source: allFiles, sortFiles, files });
    return files;
}

const visibleLibraryFiles = (files: EnteFile[]): EnteFile[] =>
    dedupeFilesById(files).filter((file) => !isFileArchivedLocally(file));
