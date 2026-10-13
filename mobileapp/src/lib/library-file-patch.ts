import type { EnteFile } from "ente-media/file";
import { extractTags } from "@/lib/tags";
import { tagsEqual } from "@/lib/tag-writes";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";

export interface LibraryFilePatchPlan {
    /** Library slot index → replacement file, for every patch to write. */
    slotPatches: Map<number, EnteFile>;
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
 * With `fileIndexById` only the patched slots are visited; without it
 * `allFiles` is walked once. Unpatched entries keep the same object identity.
 *
 * @param fileIndexById optional O(1) id→index map matching `allFiles`
 * @returns a shallow-copied array, or `null` when nothing changed
 */
export const patchFilesInLibrary = (
    allFiles: EnteFile[],
    patches: ReadonlyMap<number, EnteFile>,
    fileIndexById?: ReadonlyMap<number, number>,
): EnteFile[] | null => {
    if (patches.size === 0) {
        return null;
    }
    let next: EnteFile[] | null = null;
    if (fileIndexById) {
        for (const [fileId, patch] of patches) {
            const index = slotIndexOf(allFiles, fileId, fileIndexById);
            if (index < 0 || allFiles[index] === patch) {
                continue;
            }
            next ??= allFiles.slice();
            next[index] = patch;
        }
        return next;
    }
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
 * Plan merging resolved remote file patches into the local library snapshot.
 *
 * Only the patched slots are visited. Version-only updates (same tags +
 * archive state) still land in `slotPatches` but leave `notifyNeeded` false so
 * callers can mutate in place without triggering a gallery refilter.
 *
 * @param fileIndexById id→index map matching `allFiles`
 */
export const planLibraryFilePatches = (
    allFiles: EnteFile[],
    resolvedById: ReadonlyMap<number, EnteFile>,
    fileIndexById: ReadonlyMap<number, number>,
): LibraryFilePatchPlan => {
    let notifyNeeded = false;
    let persistNeeded = false;
    const slotPatches = new Map<number, EnteFile>();
    for (const [fileId, patch] of resolvedById) {
        const index = slotIndexOf(allFiles, fileId, fileIndexById);
        if (index < 0) {
            continue;
        }
        const file = allFiles[index]!;
        if (
            tagsEqual(extractTags(file), extractTags(patch)) &&
            isFileArchivedLocally(file) === isFileArchivedLocally(patch)
        ) {
            if (
                (file.pubMagicMetadata?.version ?? 0) ===
                    (patch.pubMagicMetadata?.version ?? 0)
            ) {
                continue;
            }
            persistNeeded = true;
            slotPatches.set(index, patch);
            continue;
        }
        notifyNeeded = true;
        persistNeeded = true;
        slotPatches.set(index, patch);
    }
    return { slotPatches, notifyNeeded, persistNeeded };
};

/**
 * Slot of `fileId` in `allFiles`, or -1 when the library does not hold it.
 * Falls back to a scan only if the index entry points at a different file.
 */
const slotIndexOf = (
    allFiles: EnteFile[],
    fileId: number,
    fileIndexById: ReadonlyMap<number, number>,
): number => {
    const index = fileIndexById.get(fileId);
    if (index === undefined) {
        return -1;
    }
    if (allFiles[index]?.id === fileId) {
        return index;
    }
    return allFiles.findIndex((file) => file.id === fileId);
};
