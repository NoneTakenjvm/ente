import type { EnteFile } from "ente-media/file";
import { extractTags } from "@/lib/tags";
import { tagsEqual } from "@/lib/tag-writes";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";

export interface LibraryFilePatchPlan {
    nextFiles: EnteFile[];
    /** True when any patch changes tags or archive visibility (notify UI). */
    notifyNeeded: boolean;
    /** True when local library bytes should be re-encrypted to disk. */
    persistNeeded: boolean;
}

/**
 * Replace one library slot in place (no array copy).
 *
 * @param fileIndexById optional O(1) id→index map
 * @returns whether a slot was updated
 */
export const patchFileInPlace = (
    allFiles: EnteFile[],
    fileId: number,
    patched: EnteFile,
    fileIndexById?: ReadonlyMap<number, number>,
): boolean => {
    const index = fileIndexById?.get(fileId) ??
        allFiles.findIndex((file) => file.id === fileId);
    if (index === undefined || index < 0 || allFiles[index] === patched) {
        return false;
    }
    allFiles[index] = patched;
    return true;
};

/**
 * Replace one library slot without mapping every file.
 *
 * @returns a shallow-copied array, or `null` when the id is missing
 */
export const patchFileInLibrary = (
    allFiles: EnteFile[],
    fileId: number,
    patched: EnteFile,
    fileIndexById?: ReadonlyMap<number, number>,
): EnteFile[] | null => {
    const index = fileIndexById?.get(fileId) ??
        allFiles.findIndex((file) => file.id === fileId);
    if (index === undefined || index < 0) {
        return null;
    }
    if (allFiles[index] === patched) {
        return null;
    }
    const next = allFiles.slice();
    next[index] = patched;
    return next;
};

/**
 * Replace several library slots in one shallow copy.
 *
 * Walks `allFiles` once. Unpatched entries keep the same object identity.
 *
 * @returns a shallow-copied array, or `null` when nothing changed
 */
export const patchFilesInLibrary = (
    allFiles: EnteFile[],
    patches: ReadonlyMap<number, EnteFile>,
): EnteFile[] | null => {
    if (patches.size === 0) {
        return null;
    }
    let next: EnteFile[] | null = null;
    for (let index = 0; index < allFiles.length; index += 1) {
        const file = allFiles[index]!;
        const patch = patches.get(file.id);
        if (!patch || patch === file) {
            continue;
        }
        if (!next) {
            next = allFiles.slice();
        }
        next[index] = patch;
    }
    return next;
};

/**
 * Merge resolved remote file patches into the local library snapshot.
 *
 * Version-only updates (same tags + archive state) keep object swaps in
 * `nextFiles` but set `notifyNeeded` false so callers can mutate in place
 * without triggering a gallery refilter.
 */
export const planLibraryFilePatches = (
    allFiles: EnteFile[],
    resolvedById: ReadonlyMap<number, EnteFile>,
): LibraryFilePatchPlan => {
    let notifyNeeded = false;
    let persistNeeded = false;
    const nextFiles = allFiles.map((file) => {
        const patch = resolvedById.get(file.id);
        if (!patch) {
            return file;
        }
        if (
            tagsEqual(extractTags(file), extractTags(patch)) &&
            isFileArchivedLocally(file) === isFileArchivedLocally(patch)
        ) {
            if (
                (file.pubMagicMetadata?.version ?? 0) ===
                    (patch.pubMagicMetadata?.version ?? 0)
            ) {
                return file;
            }
            persistNeeded = true;
            return patch;
        }
        notifyNeeded = true;
        persistNeeded = true;
        return patch;
    });
    return { nextFiles, notifyNeeded, persistNeeded };
};
