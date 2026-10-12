import { ensureArrayBufferBacked } from "ente-base/bytes";
import type { Collection } from "ente-media/collection";
import { decryptRemoteFile } from "ente-media/file";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import type { FileMetadata } from "ente-media/file-metadata";
import { createMagicMetadata } from "ente-media/magic-metadata";
import { ensureInteger } from "ente-utils/ensure";
import type { HttpClient } from "../api/http";
import { extractVideoFrameJpeg } from "@/lib/ffmpeg";
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
    type PostEnteFileRequest,
} from "./remote";

export interface UploadLocalVideoOptions {
    title: string;
    creationTime: number;
    width: number;
    height: number;
    duration: number;
    mimeType: string;
    /** Dedicated crypto worker for this upload slot (batch uploads). */
    crypto?: UploadCryptoWorker;
}

const buildMetadata = (
    hash: string,
    options: UploadLocalVideoOptions,
): FileMetadata => ({
    fileType: FileType.video,
    title: options.title,
    creationTime: ensureInteger(options.creationTime),
    modificationTime: ensureInteger(Date.now() * 1000),
    hash,
    duration: ensureInteger(options.duration),
});

const buildPublicMagicData = (
    options: UploadLocalVideoOptions,
): Record<string, unknown> => ({
    w: ensureInteger(options.width),
    h: ensureInteger(options.height),
    uploadedAt: ensureInteger(Date.now() * 1000),
    editedAt: ensureInteger(Date.now() * 1000),
});

/**
 * Encrypt, upload, and finalize a new video in the given collection.
 *
 * {@link video} is usually the picked `File`, which is streamed from disk in
 * chunks (see [Note: Streaming upload encryption]) while the poster frame is
 * decoded, so the whole video is never held in memory. File and thumbnail
 * PUTs run in parallel.
 */
export const uploadLocalVideo = async (
    http: HttpClient,
    collection: Collection,
    video: Blob,
    options: UploadLocalVideoOptions,
): Promise<EnteFile> => {
    const crypto = options.crypto ?? mainThreadCrypto();
    const fileKey = await crypto.generateBlobOrStreamKey();
    const [encryptedFile, thumbnail] = await Promise.all([
        crypto.encryptFileForUpload(video, fileKey),
        extractVideoFrameJpeg(video, options.mimeType).then(
            generateImageThumbnail,
        ),
    ]);

    const metadata = buildMetadata(encryptedFile.hash, options);
    const publicMagicMetadata = createMagicMetadata(
        buildPublicMagicData(options),
    );
    const [
        encryptedThumbnail,
        encryptedMetadata,
        encryptedPubMagicData,
        encryptedFileKey,
    ] = await Promise.all([
        crypto.encryptBlobBytes(thumbnail, fileKey),
        crypto.encryptMetadataJSON(metadata, fileKey),
        crypto.encryptMetadataJSON(publicMagicMetadata.data, fileKey),
        crypto.encryptBox(fileKey, collection.key),
    ]);

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

    const newFileRequest: PostEnteFileRequest = {
        collectionID: collection.id,
        encryptedKey: encryptedFileKey.encryptedData,
        keyDecryptionNonce: encryptedFileKey.nonce,
        file: {
            objectKey: fileUploadURL.objectKey,
            decryptionHeader: encryptedFile.decryptionHeader,
            size: encryptedFile.encryptedData.size,
        },
        thumbnail: {
            objectKey: thumbnailUploadURL.objectKey,
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
