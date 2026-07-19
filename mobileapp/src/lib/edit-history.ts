/**
 * Local-only edit history: the previous bytes for the most recent crop/rotate
 * (or mass auto-crop) replace on this client, so the user can revert once.
 *
 * Large payloads (typical phone videos) are skipped — keeping them in a Map
 * alongside ffmpeg WASM OOMs mobile Chrome.
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

/** Above this size, undo bytes are not retained in RAM. */
export const MAX_IN_MEMORY_EDIT_HISTORY_BYTES = 12 * 1024 * 1024;

const historyByFileId = new Map<number, EditHistoryEntry>();

/**
 * Remember the pre-edit bytes for a file so the latest edit can be reverted.
 * No-ops when {@link EditHistoryEntry.previousBytes} exceeds the RAM cap.
 */
export const recordEditHistory = (entry: EditHistoryEntry): void => {
    if (entry.previousBytes.byteLength > MAX_IN_MEMORY_EDIT_HISTORY_BYTES) {
        historyByFileId.delete(entry.fileId);
        return;
    }
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
