import { ensureArrayBufferBacked } from "ente-base/bytes";
import type {
    BytesOrB64,
    EncryptedBlobBytes,
} from "ente-base/crypto/types";
import type { Collection } from "ente-media/collection";
import { decryptRemoteFile } from "ente-media/file";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import type { FileMetadata } from "ente-media/file-metadata";
import { createMagicMetadata } from "ente-media/magic-metadata";
import { ensureInteger } from "ente-utils/ensure";
import type { HttpClient } from "../api/http";
import type { EncryptedUploadFile } from "./encrypt-upload-file";
import { generateImageThumbnail } from "./thumbnail";
import {
    mainThreadCrypto,
    type UploadCryptoWorker,
} from "./upload-crypto-pool";
import {
    markBatchUploadFileComplete,
    putEncryptedBlob,
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

const buildMetadata = (
    hash: string,
    options: Pick<
        UploadJpegOptions,
        "title" | "creationTime" | "modificationTime"
    >,
): FileMetadata => ({
    fileType: FileType.image,
    title: options.title,
    creationTime: ensureInteger(options.creationTime),
    modificationTime: ensureInteger(options.modificationTime),
    hash,
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
 * Thumbnail decode overlaps the single hash + encrypt + MD5 pass, and the file
 * and thumbnail PUTs run in parallel. Optional {@link UploadJpegOptions.crypto}
 * runs the crypto on the batch slot's worker instead of the main thread.
 */
export const uploadJpegImage = async (
    http: HttpClient,
    collection: Collection,
    jpegBytes: Uint8Array,
    options: UploadJpegOptions,
): Promise<EnteFile> => {
    const crypto = options.crypto ?? mainThreadCrypto();
    const fileKey = await crypto.generateBlobOrStreamKey();
    const publicMagicMetadata = createMagicMetadata(
        buildPublicMagicData(options),
    );
    const [
        { encryptedFile, encryptedThumbnail, encryptedMetadata },
        encryptedPubMagicData,
        encryptedFileKey,
    ] = await Promise.all([
        encryptImageAndThumbnail(crypto, jpegBytes, fileKey, options),
        crypto.encryptMetadataJSON(publicMagicMetadata.data, fileKey),
        crypto.encryptBox(fileKey, collection.key),
    ]);
    const { fileObjectKey, thumbnailObjectKey, thumbnailDecryptionHeader } =
        await putImageAndThumbnail(
            http,
            crypto,
            encryptedFile,
            encryptedThumbnail,
        );

    const newFileRequest: PostEnteFileRequest = {
        collectionID: collection.id,
        encryptedKey: encryptedFileKey.encryptedData,
        keyDecryptionNonce: encryptedFileKey.nonce,
        file: {
            objectKey: fileObjectKey,
            decryptionHeader: encryptedFile.decryptionHeader,
            size: encryptedFile.encryptedData.size,
        },
        thumbnail: {
            objectKey: thumbnailObjectKey,
            decryptionHeader: thumbnailDecryptionHeader,
            size: encryptedThumbnail.encryptedData.length,
        },
        metadata: encryptedMetadata,
        pubMagicMetadata: {
            version: publicMagicMetadata.version,
            count: publicMagicMetadata.count,
            data: encryptedPubMagicData.encryptedData,
            header: encryptedPubMagicData.decryptionHeader,
        },
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

    const crypto = mainThreadCrypto();
    const { metadata, encryptedFile, encryptedThumbnail, encryptedMetadata } =
        await encryptImageAndThumbnail(crypto, jpegBytes, sourceFile.key, {
            title: options.title,
            creationTime: sourceFile.metadata.creationTime,
            modificationTime: Date.now() * 1000,
        });
    const { fileObjectKey, thumbnailObjectKey, thumbnailDecryptionHeader } =
        await putImageAndThumbnail(
            http,
            crypto,
            encryptedFile,
            encryptedThumbnail,
        );

    const updateResult = await putEnteFileUpdate(http, {
        id: sourceFile.id,
        file: {
            objectKey: fileObjectKey,
            decryptionHeader: encryptedFile.decryptionHeader,
            size: encryptedFile.encryptedData.size,
        },
        thumbnail: {
            objectKey: thumbnailObjectKey,
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
            fileSize: encryptedFile.encryptedData.size,
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

/** Hash + encrypt the JPEG in one pass while the thumbnail is generated. */
const encryptImageAndThumbnail = async (
    crypto: UploadCryptoWorker,
    jpegBytes: Uint8Array,
    fileKey: BytesOrB64,
    metadataOptions: Pick<
        UploadJpegOptions,
        "title" | "creationTime" | "modificationTime"
    >,
) => {
    const [encryptedFile, thumbnail] = await Promise.all([
        crypto.encryptFileForUpload(
            new Blob([ensureArrayBufferBacked(jpegBytes)], {
                type: "image/jpeg",
            }),
            fileKey,
        ),
        generateImageThumbnail(jpegBytes),
    ]);
    const metadata = buildMetadata(encryptedFile.hash, metadataOptions);
    const [encryptedThumbnail, encryptedMetadata] = await Promise.all([
        crypto.encryptBlobBytes(thumbnail, fileKey),
        crypto.encryptMetadataJSON(metadata, fileKey),
    ]);
    return { metadata, encryptedFile, encryptedThumbnail, encryptedMetadata };
};

/** PUT the encrypted file and thumbnail in parallel. */
const putImageAndThumbnail = async (
    http: HttpClient,
    crypto: UploadCryptoWorker,
    encryptedFile: EncryptedUploadFile,
    encryptedThumbnail: EncryptedBlobBytes,
) => {
    const [fileUploadURL, thumbnailUploadURL, thumbnailDecryptionHeader] =
        await Promise.all([
            putEncryptedBlob(
                http,
                encryptedFile.encryptedData,
                encryptedFile.contentMd5,
            ),
            putEncryptedObject(
                http,
                ensureArrayBufferBacked(encryptedThumbnail.encryptedData),
            ),
            crypto.toB64(encryptedThumbnail.decryptionHeader),
        ]);
    return {
        fileObjectKey: fileUploadURL.objectKey,
        thumbnailObjectKey: thumbnailUploadURL.objectKey,
        thumbnailDecryptionHeader,
    };
};
