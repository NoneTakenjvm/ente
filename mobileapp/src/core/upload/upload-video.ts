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
import { extractVideoFrameJpeg } from "@/lib/ffmpeg";
import { generateImageThumbnail } from "./thumbnail";
import type { UploadCryptoWorker } from "./upload-crypto-pool";
import {
    markBatchUploadFileComplete,
    takeUploadURL,
} from "./upload-url-pool";
import {
    postEnteFile,
    putFile,
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
    videoBytes: Uint8Array,
    options: UploadLocalVideoOptions,
): Promise<FileMetadata> => ({
    fileType: FileType.video,
    title: options.title,
    creationTime: ensureInteger(options.creationTime),
    modificationTime: ensureInteger(Date.now() * 1000),
    hash: await computeContentHash(videoBytes, options.crypto),
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
 * Hash overlaps with poster-frame extract; encrypt and PUTs run in parallel.
 */
export const uploadLocalVideo = async (
    http: HttpClient,
    collection: Collection,
    videoBytes: Uint8Array,
    options: UploadLocalVideoOptions,
): Promise<EnteFile> => {
    const crypto = options.crypto;
    const [metadata, frame] = await Promise.all([
        buildMetadata(videoBytes, options),
        extractVideoFrameJpeg(videoBytes, options.mimeType),
    ]);
    const thumbnail = await generateImageThumbnail(frame);

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
            crypto.encryptStreamBytes(videoBytes, fileKey) :
            encryptStreamBytes(videoBytes, fileKey),
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

    const [fileUploadURL, thumbnailUploadURL] = await Promise.all([
        takeUploadURL(http),
        takeUploadURL(http),
    ]);

    const thumbnailDecryptionHeader = crypto ?
        await crypto.toB64(encryptedThumbnail.decryptionHeader) :
        await toB64(encryptedThumbnail.decryptionHeader);

    await Promise.all([
        putFile(
            http,
            fileUploadURL.url,
            ensureArrayBufferBacked(encryptedFile.encryptedData),
        ),
        putFile(
            http,
            thumbnailUploadURL.url,
            ensureArrayBufferBacked(encryptedThumbnail.encryptedData),
        ),
    ]);

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
