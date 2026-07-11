/**
 * Local-only edit history: the previous bytes for the most recent crop/rotate
 * (or mass auto-crop) replace on this client, so the user can revert once.
 */

export interface EditHistoryEntry {
    fileId: number;
    /** Previous file id before replace (trashed source). */
    previousFileId?: number;
    previousBytes: Uint8Array;
    width: number;
    height: number;
    createdAt: number;
    kind: "crop" | "rotate" | "auto-crop" | "video-edit";
}

const historyByFileId = new Map<number, EditHistoryEntry>();

/**
 * Remember the pre-edit bytes for a file so the latest edit can be reverted.
 */
export const recordEditHistory = (entry: EditHistoryEntry): void => {
    historyByFileId.set(entry.fileId, entry);
};

/**
 * After a derived replace, move history from the old id to the new uploaded id.
 */
export const remapEditHistoryFileId = (
    fromFileId: number,
    toFileId: number,
): void => {
    const existing = historyByFileId.get(fromFileId);
    if (!existing) {
        return;
    }
    historyByFileId.delete(fromFileId);
    historyByFileId.set(toFileId, {
        ...existing,
        fileId: toFileId,
        previousFileId: fromFileId,
    });
};

export const getEditHistory = (
    fileId: number,
): EditHistoryEntry | undefined => historyByFileId.get(fileId);

export const clearEditHistory = (fileId: number): void => {
    historyByFileId.delete(fileId);
};

export const clearAllEditHistory = (): void => {
    historyByFileId.clear();
};

export const hasEditHistory = (fileId: number): boolean =>
    historyByFileId.has(fileId);
