import { lowercaseExtension } from "ente-base/file-name";
import { fileFileName } from "ente-media/file-metadata";
import { FileType } from "ente-media/file-type";
import { isHEICExtension } from "ente-media/formats";
import { heicToJPEG } from "ente-media/heic-convert";
import { decodeLivePhoto } from "ente-media/live-photo";
import type { EnteFile } from "ente-media/file";
import { detectImageFormatFromBytes } from "@/lib/compress";

/**
 * Tiny HEIC used only to probe native browser decode support.
 *
 * @see web/packages/gallery/services/convert.ts
 */
const testHEICDataURL =
    "data:image/heic;base64,AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAABaW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAADnBpdG0AAAAAAAEAAAAiaWxvYwAAAABEQAABAAEAAAAAAYkAAQAAAAAAAAAuAAAAI2lpbmYAAAAAAAEAAAAVaW5mZQIAAAAAAQAAaHZjMQAAAADpaXBycAAAAMppcGNvAAAAdmh2Y0MBA3AAAAAAAAAAAAAe8AD8/fj4AAAPAyAAAQAYQAEMAf//A3AAAAMAkAAAAwAAAwAeugJAIQABACpCAQEDcAAAAwCQAAADAAADAB6gIIEFluqumubgIaDAgAAAAwCAAAADAIQiAAEABkQBwXPBiQAAABRpc3BlAAAAAAAAAEAAAABAAAAAKGNsYXAAAAABAAAAAQAAAAEAAAAB////wQAAAAL////BAAAAAgAAABBwaXhpAAAAAAMICAgAAAAXaXBtYQAAAAAAAAABAAEEgQKDBAAAADZtZGF0AAAAKigBrwayEx2gkim3i/2Rd0CR/V6h6GbEyV3dheegYfLV9ZwraCH8nff+7w==";

let heicSupportPromise: Promise<boolean> | undefined;

/**
 * Return true when this browser can decode HEIC in an {@link HTMLImageElement}.
 */
export const isHEICSupported = (): Promise<boolean> => {
    heicSupportPromise ??= new Promise((resolve) => {
        const image = new Image();
        image.onload = (): void => resolve(true);
        image.onerror = (): void => resolve(false);
        image.src = testHEICDataURL;
    });
    return heicSupportPromise;
};

const mimeTypeForImageName = (fileName: string, bytes: Uint8Array): string => {
    const extension = lowercaseExtension(fileName) ?? "";
    if (extension === "png") {
        return "image/png";
    }
    if (extension === "webp") {
        return "image/webp";
    }
    if (extension === "avif") {
        return "image/avif";
    }
    if (extension === "gif") {
        return "image/gif";
    }
    if (isHEICExtension(extension)) {
        return "image/heic";
    }
    const detected = detectImageFormatFromBytes(bytes);
    if (detected === "png") {
        return "image/png";
    }
    if (detected === "webp") {
        return "image/webp";
    }
    if (detected === "avif") {
        return "image/avif";
    }
    if (detected === "gif") {
        return "image/gif";
    }
    if (detected === "heic") {
        return "image/heic";
    }
    return "image/jpeg";
};

const bytesToArrayBufferBlob = (
    bytes: Uint8Array,
    mimeType: string,
): Blob => new Blob([Uint8Array.from(bytes)], { type: mimeType });

/**
 * Build a {@link Blob} the browser can show in an {@link HTMLImageElement}.
 *
 * Live photos are unzipped to their still image. HEIC/HEIF is converted to JPEG
 * unless the browser already decodes HEIC natively (Safari).
 */
export const toRenderableImageBlob = async (
    file: EnteFile,
    encryptedFileBytes: Uint8Array,
): Promise<Blob> => {
    let imageBytes = encryptedFileBytes;
    let imageName = fileFileName(file);

    if (file.metadata.fileType === FileType.livePhoto) {
        const livePhoto = await decodeLivePhoto(
            imageName,
            bytesToArrayBufferBlob(encryptedFileBytes, "application/zip"),
        );
        imageBytes = livePhoto.imageData;
        imageName = livePhoto.imageFileName;
    }

    const extension = lowercaseExtension(imageName) ?? "";
    const isHeic =
        isHEICExtension(extension) ||
        detectImageFormatFromBytes(imageBytes) === "heic";

    if (isHeic) {
        const heicBlob = bytesToArrayBufferBlob(imageBytes, "image/heic");
        if (await isHEICSupported()) {
            return heicBlob;
        }
        return heicToJPEG(heicBlob);
    }

    return bytesToArrayBufferBlob(
        imageBytes,
        mimeTypeForImageName(imageName, imageBytes),
    );
};
