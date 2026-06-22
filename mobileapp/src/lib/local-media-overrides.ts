const overrides = new Map<number, Uint8Array>();

/**
 * Hold decrypted bytes for a file while a derived replace upload is in flight.
 */
export const setLocalMediaOverride = (
    fileId: number,
    bytes: Uint8Array,
): void => {
    overrides.set(fileId, bytes);
};

export const getLocalMediaOverride = (
    fileId: number,
): Uint8Array | undefined => overrides.get(fileId);

export const clearLocalMediaOverride = (fileId: number): void => {
    overrides.delete(fileId);
};
