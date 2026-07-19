/**
 * Build a Blob from bytes.
 *
 * Dom lib typings reject `Uint8Array<ArrayBufferLike>` as {@link BlobPart}
 * under the TS version Next uses in CI. {@link Uint8Array.from} yields a
 * plain ArrayBuffer-backed view that typechecks (same workaround as elsewhere
 * in this package).
 */
export const blobFromUint8Array = (
    bytes: Uint8Array,
    type: string,
): Blob => new Blob([Uint8Array.from(bytes)], { type });
