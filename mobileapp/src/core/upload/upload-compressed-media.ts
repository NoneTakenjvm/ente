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
    fetchUploadURL,
    postEnteFile,
    putFile,
    type PostEnteFileRequest,
} from "./remote";
import type { CompressMediaResult } from "@/lib/transcode/compress-media";

const computeContentHash = async (data: Uint8Array): Promise<string> => {
    const hashState = await chunkHashInit();
    await chunkHashUpdate(hashState, data);
    return chunkHashFinal(hashState);
};

const buildMetadata = async (
    fileType: number,
    bytes: Uint8Array,
    sourceFile: EnteFile,
    title: string,
    duration?: number,
): Promise<FileMetadata> => ({
    fileType,
    title,
    creationTime: sourceFile.metadata.creationTime,
    modificationTime: ensureInteger(Date.now() * 1000),
    hash: await computeContentHash(bytes),
    duration,
});

const buildPublicMagicData = (
    width: number,
    height: number,
    uploadedAt: number,
    organizerTags: string[],
): Record<string, unknown> => ({
    w: ensureInteger(width),
    h: ensureInteger(height),
    uploadedAt: ensureInteger(uploadedAt),
    editedAt: ensureInteger(Date.now() * 1000),
    _organizer_v1: {
        tags: organizerTags,
        updatedAt: Date.now() * 1000,
    },
});

/**
 * Upload a compressed derivative (JPEG, AVIF, WebP, GIF, or MP4) of an existing file.
 *
 * {@link onProgress} reports a 0–1 upload-stage ratio (thumbnail prep, file PUT,
 * thumb PUT + finalize).
 */
export const uploadCompressedMedia = async (
    http: HttpClient,
    sourceFile: EnteFile,
    result: CompressMediaResult,
    collection: Collection,
    title: string,
    organizerTags: string[] = ["compressed"],
    onProgress?: (ratio: number) => void,
): Promise<EnteFile> => {
    const fileType =
        result.mimeType.startsWith("video/") ?
            FileType.video :
            FileType.image;

    const metadata = await buildMetadata(
        fileType,
        result.bytes,
        sourceFile,
        title,
        result.duration,
    );

    onProgress?.(0.05);
    let thumbnail: Uint8Array;
    if (fileType === FileType.video) {
        const frame = await extractVideoFrameJpeg(result.bytes, result.mimeType);
        thumbnail = await generateImageThumbnail(frame);
    } else if (result.mimeType === "image/gif") {
        const frame = await extractVideoFrameJpeg(result.bytes, "image/gif");
        thumbnail = await generateImageThumbnail(frame);
    } else {
        thumbnail = await generateImageThumbnail(result.bytes, result.mimeType);
    }
    onProgress?.(0.12);

    const fileKey = await generateBlobOrStreamKey();
    const encryptedFile = await encryptStreamBytes(result.bytes, fileKey);
    const encryptedThumbnail = await encryptBlobBytes(thumbnail, fileKey);
    const encryptedMetadata = await encryptMetadataJSON(metadata, fileKey);
    onProgress?.(0.15);

    const publicMagicData = buildPublicMagicData(
        result.width,
        result.height,
        sourceFile.pubMagicMetadata?.data.uploadedAt ??
            sourceFile.updationTime ??
            sourceFile.metadata.creationTime,
        organizerTags,
    );
    const publicMagicMetadata = createMagicMetadata(publicMagicData);
    const encryptedPubMagicMetadata = publicMagicMetadata.count ?
        await encryptMagicMetadata(publicMagicMetadata, fileKey) :
        undefined;

    const encryptedFileKey = await encryptBox(fileKey, collection.key);

    const fileUploadURL = await fetchUploadURL(http);
    await putFile(
        http,
        fileUploadURL.url,
        encryptedFile.encryptedData,
        onProgress ?
            (loaded, total) => {
                const putRatio = total > 0 ? loaded / total : 1;
                onProgress(0.15 + putRatio * 0.75);
            } :
            undefined,
    );

    const thumbnailUploadURL = await fetchUploadURL(http);
    onProgress?.(0.92);
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
    onProgress?.(1);
    return decryptRemoteFile(remoteFile, collection.key);
};
