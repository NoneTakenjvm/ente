import { ensureArrayBufferBacked } from "ente-base/bytes";
import {
    chunkHashFinal,
    chunkHashInit,
    chunkHashUpdate,
} from "ente-base/crypto/libsodium";
import {
    encryptBlobBytes,
    encryptBox,
    encryptMetadataJSON,
    encryptStreamBytes,
    generateBlobOrStreamKey,
    toB64,
} from "ente-base/crypto";
import type { Collection } from "ente-media/collection";
import { decryptRemoteFile } from "ente-media/file";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import type { FileMetadata } from "ente-media/file-metadata";
import {
    createMagicMetadata,
    encryptMagicMetadata,
} from "ente-media/magic-metadata";
import { ensureInteger } from "ente-utils/ensure";
import type { HttpClient } from "../api/http";
import { generateImageThumbnail } from "./thumbnail";
import type { UploadCryptoWorker } from "./upload-crypto-pool";
import {
    markBatchUploadFileComplete,
    putEncryptedObject,
} from "./upload-url-pool";
import {
    postEnteFile,
    putEnteFileUpdate,
    type PostEnteFileRequest,
} from "./remote";
import { updatePublicMetadata } from "../metadata";
import { buildOrganizerUpdate } from "@/lib/tag-writes";

export interface UploadJpegOptions {
    title: string;
    creationTime: number;
    modificationTime: number;
    width: number;
    height: number;
    organizerTags?: string[];
    /**
     * When set, this is a derived reupload of an existing file: the source
     * file's upload time is preserved so the new file keeps its position, and
     * the edit time is bumped instead.
     */
    uploadedAt?: number;
    /** Dedicated crypto worker for this upload slot (batch uploads). */
    crypto?: UploadCryptoWorker;
}

const computeContentHash = async (
    data: Uint8Array,
    crypto?: UploadCryptoWorker,
): Promise<string> => {
    if (crypto) {
        const hashState = await crypto.chunkHashInit();
        await crypto.chunkHashUpdate(hashState, data);
        return crypto.chunkHashFinal(hashState);
    }
    const hashState = await chunkHashInit();
    await chunkHashUpdate(hashState, data);
    return chunkHashFinal(hashState);
};

const buildMetadata = async (
    jpegBytes: Uint8Array,
    options: UploadJpegOptions,
): Promise<FileMetadata> => ({
    fileType: FileType.image,
    title: options.title,
    creationTime: ensureInteger(options.creationTime),
    modificationTime: ensureInteger(options.modificationTime),
    hash: await computeContentHash(jpegBytes, options.crypto),
});

const buildPublicMagicData = (
    options: UploadJpegOptions,
): Record<string, unknown> => {
    const data: Record<string, unknown> = {
        w: ensureInteger(options.width),
        h: ensureInteger(options.height),
        // Original uploads stamp their upload time once; derived reuploads
        // preserve the source file's time + record the edit instead.
        uploadedAt: ensureInteger(options.uploadedAt ?? Date.now() * 1000),
        editedAt: ensureInteger(Date.now() * 1000),
    };
    if (options.organizerTags?.length) {
        data._organizer_v1 = {
            tags: options.organizerTags,
            updatedAt: Date.now() * 1000,
        };
    }
    return data;
};

/**
 * Encrypt, upload, and finalize a new JPEG file in the given collection.
 *
 * Hash + thumbnail decode run in parallel; encrypt steps and file/thumbnail
 * PUTs also overlap. Optional {@link UploadJpegOptions.crypto} uses a
 * dedicated worker so concurrent batch uploads do not serialize on the shared
 * crypto worker (official Photos upload manager pattern).
 */
export const uploadJpegImage = async (
    http: HttpClient,
    collection: Collection,
    jpegBytes: Uint8Array,
    options: UploadJpegOptions,
): Promise<EnteFile> => {
    const crypto = options.crypto;
    const [metadata, thumbnail] = await Promise.all([
        buildMetadata(jpegBytes, options),
        generateImageThumbnail(jpegBytes),
    ]);

    const fileKey = crypto ?
        await crypto.generateBlobOrStreamKey() :
        await generateBlobOrStreamKey();

    const publicMagicData = buildPublicMagicData(options);
    const publicMagicMetadata = createMagicMetadata(publicMagicData);

    const encryptPubMagic = async (): Promise<
        PostEnteFileRequest["pubMagicMetadata"]
    > => {
        if (!publicMagicMetadata.count) {
            return undefined;
        }
        if (crypto) {
            const { encryptedData: data, decryptionHeader: header } =
                await crypto.encryptMetadataJSON(publicMagicMetadata.data, fileKey);
            return {
                version: publicMagicMetadata.version,
                count: publicMagicMetadata.count,
                data,
                header,
            };
        }
        return encryptMagicMetadata(publicMagicMetadata, fileKey);
    };

    const [
        encryptedFile,
        encryptedThumbnail,
        encryptedMetadata,
        encryptedPubMagicMetadata,
        encryptedFileKey,
    ] = await Promise.all([
        crypto ?
            crypto.encryptStreamBytes(jpegBytes, fileKey) :
            encryptStreamBytes(jpegBytes, fileKey),
        crypto ?
            crypto.encryptBlobBytes(thumbnail, fileKey) :
            encryptBlobBytes(thumbnail, fileKey),
        crypto ?
            crypto.encryptMetadataJSON(metadata, fileKey) :
            encryptMetadataJSON(metadata, fileKey),
        encryptPubMagic(),
        crypto ?
            crypto.encryptBox(fileKey, collection.key) :
            encryptBox(fileKey, collection.key),
    ]);

    // Sequential mint+PUT — parallel URL-pool take raced on mobile; checksum
    // URLs also require the encrypted payload first.
    const fileUploadURL = await putEncryptedObject(
        http,
        ensureArrayBufferBacked(encryptedFile.encryptedData),
    );
    const thumbnailUploadURL = await putEncryptedObject(
        http,
        ensureArrayBufferBacked(encryptedThumbnail.encryptedData),
    );

    const thumbnailDecryptionHeader = crypto ?
        await crypto.toB64(encryptedThumbnail.decryptionHeader) :
        await toB64(encryptedThumbnail.decryptionHeader);

    const newFileRequest: PostEnteFileRequest = {
        collectionID: collection.id,
        encryptedKey: encryptedFileKey.encryptedData,
        keyDecryptionNonce: encryptedFileKey.nonce,
        file: {
            objectKey: fileUploadURL.objectKey,
            decryptionHeader: encryptedFile.decryptionHeader,
            size: encryptedFile.encryptedData.length,
        },
        thumbnail: {
            objectKey: thumbnailUploadURL.objectKey,
            decryptionHeader: thumbnailDecryptionHeader,
            size: encryptedThumbnail.encryptedData.length,
        },
        metadata: encryptedMetadata,
        pubMagicMetadata: encryptedPubMagicMetadata,
    };

    const remoteFile = await postEnteFile(http, newFileRequest);
    markBatchUploadFileComplete();
    return decryptRemoteFile(remoteFile, collection.key);
};

export interface UploadDerivedImageOptions {
    title: string;
    organizerTags?: string[];
}

/**
 * Upload a JPEG derived from an existing library file (compress, crop, etc.).
 */
export const uploadDerivedImage = async (
    http: HttpClient,
    sourceFile: EnteFile,
    jpegBytes: Uint8Array,
    collection: Collection,
    dimensions: { width: number; height: number },
    options: UploadDerivedImageOptions,
): Promise<EnteFile> => {
    const nowMicros = Date.now() * 1000;
    // Prefer stamped uploadedAt; otherwise keep the source's gallery sort key
    // (updationTime → creationTime) so crops don't jump to "just uploaded".
    const uploadedAt =
        sourceFile.pubMagicMetadata?.data.uploadedAt ??
        sourceFile.updationTime ??
        sourceFile.metadata.creationTime;
    return uploadJpegImage(http, collection, jpegBytes, {
        title: options.title,
        creationTime: sourceFile.metadata.creationTime,
        modificationTime: nowMicros,
        width: dimensions.width,
        height: dimensions.height,
        organizerTags: options.organizerTags,
        uploadedAt,
    });
};

/**
 * Upload a compressed JPEG derived from an existing library file.
 */
export const uploadCompressedImage = async (
    http: HttpClient,
    sourceFile: EnteFile,
    compressedBytes: Uint8Array,
    collection: Collection,
    dimensions: { width: number; height: number },
    title: string,
    organizerTags: string[] = ["compressed"],
): Promise<EnteFile> =>
    uploadDerivedImage(
        http,
        sourceFile,
        compressedBytes,
        collection,
        dimensions,
        { title, organizerTags },
    );

/**
 * Upload a cropped JPEG derived from an existing library file.
 */
export const uploadCroppedImage = async (
    http: HttpClient,
    sourceFile: EnteFile,
    croppedBytes: Uint8Array,
    collection: Collection,
    dimensions: { width: number; height: number },
    title: string,
    organizerTags: string[] = ["cropped"],
): Promise<EnteFile> =>
    uploadDerivedImage(
        http,
        sourceFile,
        croppedBytes,
        collection,
        dimensions,
        { title, organizerTags },
    );

/**
 * Upload a rotated JPEG as a new file id (legacy derive-copy path).
 *
 * Prefer {@link updateRotatedImageInPlace} so tags, favourites, and sessions
 * stay on the same file id.
 */
export const uploadRotatedImage = async (
    http: HttpClient,
    sourceFile: EnteFile,
    jpegBytes: Uint8Array,
    collection: Collection,
    dimensions: { width: number; height: number },
    title: string,
    organizerTags: string[] = ["rotated"],
): Promise<EnteFile> =>
    uploadDerivedImage(
        http,
        sourceFile,
        jpegBytes,
        collection,
        dimensions,
        { title, organizerTags },
    );

export interface UpdateImageInPlaceOptions {
    title: string;
    width: number;
    height: number;
    /** Organizer tags to merge into existing public magic metadata. */
    organizerTags: string[];
}

/**
 * Replace an owned file's bytes and thumbnail in place (same file id + key).
 *
 * Updates immutable encrypted metadata (hash / title / modificationTime), then
 * merges dimensions + organizer tags into existing public magic metadata so
 * captions and other fields are preserved.
 */
export const updateImageBytesInPlace = async (
    http: HttpClient,
    sourceFile: EnteFile,
    jpegBytes: Uint8Array,
    options: UpdateImageInPlaceOptions,
): Promise<EnteFile> => {
    if (!sourceFile.key) {
        throw new Error(`File ${sourceFile.id} has no decryption key`);
    }

    const nowMicros = Date.now() * 1000;
    const metadata = await buildMetadata(jpegBytes, {
        title: options.title,
        creationTime: sourceFile.metadata.creationTime,
        modificationTime: nowMicros,
        width: options.width,
        height: options.height,
    });
    const thumbnail = await generateImageThumbnail(jpegBytes);
    const fileKey = sourceFile.key;

    const encryptedFile = await encryptStreamBytes(jpegBytes, fileKey);
    const encryptedThumbnail = await encryptBlobBytes(thumbnail, fileKey);
    const encryptedMetadata = await encryptMetadataJSON(metadata, fileKey);

    const fileUploadURL = await putEncryptedObject(
        http,
        ensureArrayBufferBacked(encryptedFile.encryptedData),
    );
    const thumbnailUploadURL = await putEncryptedObject(
        http,
        ensureArrayBufferBacked(encryptedThumbnail.encryptedData),
    );

    const thumbnailDecryptionHeader = await toB64(
        encryptedThumbnail.decryptionHeader,
    );

    const updateResult = await putEnteFileUpdate(http, {
        id: sourceFile.id,
        file: {
            objectKey: fileUploadURL.objectKey,
            decryptionHeader: encryptedFile.decryptionHeader,
            size: encryptedFile.encryptedData.length,
        },
        thumbnail: {
            objectKey: thumbnailUploadURL.objectKey,
            decryptionHeader: thumbnailDecryptionHeader,
            size: encryptedThumbnail.encryptedData.length,
        },
        metadata: encryptedMetadata,
    });
    markBatchUploadFileComplete();

    const updated: EnteFile = {
        ...sourceFile,
        updationTime: updateResult.updationTime,
        metadata,
        file: {
            ...sourceFile.file,
            decryptionHeader: encryptedFile.decryptionHeader,
        },
        thumbnail: {
            ...sourceFile.thumbnail,
            decryptionHeader: thumbnailDecryptionHeader,
        },
        info: {
            ...sourceFile.info,
            fileSize: encryptedFile.encryptedData.length,
            thumbSize: encryptedThumbnail.encryptedData.length,
        },
    };

    await updatePublicMetadata(http, updated, {
        w: ensureInteger(options.width),
        h: ensureInteger(options.height),
        ...buildOrganizerUpdate(options.organizerTags),
    });

    return updated;
};

/**
 * Rotate an owned image in place (same file id), preserving pub magic fields.
 */
export const updateRotatedImageInPlace = async (
    http: HttpClient,
    sourceFile: EnteFile,
    jpegBytes: Uint8Array,
    dimensions: { width: number; height: number },
    title: string,
    organizerTags: string[],
): Promise<EnteFile> =>
    updateImageBytesInPlace(http, sourceFile, jpegBytes, {
        title,
        width: dimensions.width,
        height: dimensions.height,
        organizerTags,
    });

export interface UploadLocalImageOptions {
    title: string;
    creationTime: number;
    width: number;
    height: number;
    /** Dedicated crypto worker for this upload slot (batch uploads). */
    crypto?: UploadCryptoWorker;
}

/**
 * Upload a new JPEG from the device (not derived from an existing library file).
 */
export const uploadLocalImage = async (
    http: HttpClient,
    collection: Collection,
    jpegBytes: Uint8Array,
    options: UploadLocalImageOptions,
): Promise<EnteFile> => {
    const nowMicros = Date.now() * 1000;
    return uploadJpegImage(http, collection, jpegBytes, {
        title: options.title,
        creationTime: options.creationTime,
        modificationTime: nowMicros,
        width: options.width,
        height: options.height,
        crypto: options.crypto,
    });
};
