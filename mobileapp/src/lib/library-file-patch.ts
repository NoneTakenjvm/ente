import type { EnteFile } from "ente-media/file";
import { extractTags } from "@/lib/tags";
import { tagsEqual } from "@/lib/tag-writes";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";

/**
 * Replace library slots in one shallow copy. The input array is never mutated,
 * so `allFiles` identity changes on every patch and memo consumers refresh.
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
 * Pick which resolved remote file patches differ from the local library
 * snapshot in tags, archive state or pubMagicMetadata version.
 *
 * Only the patched slots are visited.
 *
 * @param fileIndexById id→index map matching `allFiles`
 * @returns file id → replacement file, for the patches worth writing
 */
export const planLibraryFilePatches = (
    allFiles: EnteFile[],
    resolvedById: ReadonlyMap<number, EnteFile>,
    fileIndexById: ReadonlyMap<number, number>,
): Map<number, EnteFile> => {
    const patches = new Map<number, EnteFile>();
    for (const [fileId, patch] of resolvedById) {
        const index = slotIndexOf(allFiles, fileId, fileIndexById);
        if (index < 0) {
            continue;
        }
        const file = allFiles[index]!;
        if (
            tagsEqual(extractTags(file), extractTags(patch)) &&
            isFileArchivedLocally(file) === isFileArchivedLocally(patch) &&
            (file.pubMagicMetadata?.version ?? 0) ===
                (patch.pubMagicMetadata?.version ?? 0)
        ) {
            continue;
        }
        patches.set(fileId, patch);
    }
    return patches;
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
