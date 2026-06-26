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
}

const computeContentHash = async (data: Uint8Array): Promise<string> => {
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
    hash: await computeContentHash(videoBytes),
    duration: ensureInteger(options.duration),
});

const buildPublicMagicData = (
    options: UploadLocalVideoOptions,
): Record<string, unknown> => ({
    w: ensureInteger(options.width),
    h: ensureInteger(options.height),
});

/**
 * Encrypt, upload, and finalize a new video in the given collection.
 */
export const uploadLocalVideo = async (
    http: HttpClient,
    collection: Collection,
    videoBytes: Uint8Array,
    options: UploadLocalVideoOptions,
): Promise<EnteFile> => {
    const metadata = await buildMetadata(videoBytes, options);
    const frame = await extractVideoFrameJpeg(videoBytes, options.mimeType);
    const thumbnail = await generateImageThumbnail(frame);
    const fileKey = await generateBlobOrStreamKey();

    const encryptedFile = await encryptStreamBytes(videoBytes, fileKey);
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
            decryptionHeader: await toB64(encryptedThumbnail.decryptionHeader),
            size: encryptedThumbnail.encryptedData.length,
        },
        metadata: encryptedMetadata,
        pubMagicMetadata: encryptedPubMagicMetadata,
    };

    const remoteFile = await postEnteFile(http, newFileRequest);
    markBatchUploadFileComplete();
    return decryptRemoteFile(remoteFile, collection.key);
};
