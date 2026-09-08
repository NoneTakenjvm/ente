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
