import type { EnteFile } from "ente-media/file";

/**
 * Build a file-id → array-index map for O(1) library lookups.
 */
export const buildFileIndexById = (
    files: readonly EnteFile[],
): Map<number, number> => {
    const index = new Map<number, number>();
    for (let i = 0; i < files.length; i += 1) {
        index.set(files[i]!.id, i);
    }
    return index;
};
