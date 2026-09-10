/**
 * Build a Blob from bytes.
 *
 * Dom lib typings reject `Uint8Array<ArrayBufferLike>` as {@link BlobPart}
 * under the TS version Next uses in CI. Cast through `BlobPart` instead of
 * copying with {@link Uint8Array.from}.
 */
export const blobFromUint8Array = (
    bytes: Uint8Array,
    type: string,
): Blob => new Blob([bytes as BlobPart], { type });

/**
 * Copy {@link bytes} into a standalone {@link ArrayBuffer} for postMessage transfer.
 */
export const arrayBufferFromUint8Array = (bytes: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
};
