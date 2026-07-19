/**
 * Build a Blob from bytes without the extra copy from {@link Uint8Array.from}.
 */
export const blobFromUint8Array = (
    bytes: Uint8Array,
    type: string,
): Blob => new Blob([bytes], { type });
