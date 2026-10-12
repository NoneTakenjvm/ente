import {
    chunkHashFinal,
    chunkHashInit,
    chunkHashUpdate,
    encryptStreamChunk,
    initChunkEncryption,
} from "ente-base/crypto/libsodium";
import {
    streamEncryptionChunkSize,
    type BytesOrB64,
} from "ente-base/crypto/types";
import { createMd5 } from "./md5";

/** A file encrypted for upload, plus the digests the upload needs. */
export interface EncryptedUploadFile {
    /**
     * Ciphertext as a {@link Blob} built from per-chunk Blobs, so large videos
     * leave the JS heap as they are encrypted instead of being held whole.
     */
    encryptedData: Blob;
    decryptionHeader: string;
    /** Blake2b hash of the plaintext (Ente `metadata.hash`). */
    hash: string;
    /** Base64 MD5 of the ciphertext for the checksum-bound upload URL. */
    contentMd5: string;
}

/**
 * Stream-encrypt {@link source} for upload in one pass over its bytes.
 *
 * [Note: Streaming upload encryption]
 *
 * Reads {@link streamEncryptionChunkSize} slices from the Blob (a picked
 * `File` is read lazily from disk), and for each slice updates the plaintext
 * hash, encrypts it with secretstream, and updates the ciphertext MD5. The
 * output is byte-identical in format to `encryptStreamBytes`, but peak memory
 * is about one chunk instead of several copies of the whole file, and the
 * libsodium WASM heap never has to grow to the file's size.
 *
 * Yields a macrotask between chunks so that, when this runs on the main thread
 * (iOS, or a crypto worker that failed to start), the UI can still paint.
 */
export const encryptFileForUpload = async (
    source: Blob,
    key: BytesOrB64,
): Promise<EncryptedUploadFile> => {
    const hashState = await chunkHashInit();
    const { decryptionHeader, pushState } = await initChunkEncryption(key);
    const md5 = createMd5();
    const encryptedParts: Blob[] = [];

    let offset = 0;
    let isFinalChunk = false;
    while (!isFinalChunk) {
        const end = Math.min(offset + streamEncryptionChunkSize, source.size);
        isFinalChunk = end >= source.size;
        const chunk = new Uint8Array(
            await source.slice(offset, end).arrayBuffer(),
        );
        offset = end;
        await chunkHashUpdate(hashState, chunk);
        const encryptedChunk = await encryptStreamChunk(
            chunk,
            pushState,
            isFinalChunk,
        );
        md5.update(encryptedChunk);
        encryptedParts.push(new Blob([encryptedChunk]));
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return {
        encryptedData: new Blob(encryptedParts),
        decryptionHeader,
        hash: await chunkHashFinal(hashState),
        contentMd5: md5.digestBase64(),
    };
};
