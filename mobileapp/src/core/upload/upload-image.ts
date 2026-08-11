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
import {
    markBatchUploadFileComplete,
    takeUploadURL,
} from "./upload-url-pool";
import {
    postEnteFile,
    putFile,
    type PostEnteFileRequest,
} from "./remote";

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
}

const computeContentHash = async (data: Uint8Array): Promise<string> => {
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
    hash: await computeContentHash(jpegBytes),
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
 */
export const uploadJpegImage = async (
    http: HttpClient,
    collection: Collection,
    jpegBytes: Uint8Array,
    options: UploadJpegOptions,
): Promise<EnteFile> => {
    const metadata = await buildMetadata(jpegBytes, options);
    const thumbnail = await generateImageThumbnail(jpegBytes);
    const fileKey = await generateBlobOrStreamKey();

    const encryptedFile = await encryptStreamBytes(jpegBytes, fileKey);
    const encryptedThumbnail = await encryptBlobBytes(thumbnail, fileKey);
    const encryptedMetadata = await encryptMetadataJSON(metadata, fileKey);

    const publicMagicData = buildPublicMagicData(options);
    const publicMagicMetadata = createMagicMetadata(publicMagicData);
    const encryptedPubMagicMetadata = publicMagicMetadata.count ?
        await encryptMagicMetadata(publicMagicMetadata, fileKey) :
        undefined;

    const encryptedFileKey = await encryptBox(fileKey, collection.key);

    const fileUploadURL = await takeUploadURL(http);
    await putFile(http, fileUploadURL.url, encryptedFile.encryptedData);

    const thumbnailUploadURL = await takeUploadURL(http);
    await putFile(
        http,
        thumbnailUploadURL.url,
        encryptedThumbnail.encryptedData,
    );

    const thumbnailDecryptionHeader = await toB64(
        encryptedThumbnail.decryptionHeader,
    );

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
 * Upload a rotated JPEG derived from an existing library file.
 */
export const uploadRotatedImage = async (
    http: HttpClient,
    sourceFile: EnteFile,
    jpegBytes: Uint8Array,
    collection: Collection,
    dimensions: { width: number; height: number },
    title: string,
): Promise<EnteFile> =>
    uploadDerivedImage(
        http,
        sourceFile,
        jpegBytes,
        collection,
        dimensions,
        { title, organizerTags: ["rotated"] },
    );

export interface UploadLocalImageOptions {
    title: string;
    creationTime: number;
    width: number;
    height: number;
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
    });
};
