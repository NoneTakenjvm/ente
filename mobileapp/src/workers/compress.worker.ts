/// <reference lib="webworker" />

import decodeJpeg from "@jsquash/jpeg/decode";
import encodeJpeg from "@jsquash/jpeg/encode";
import decodePng from "@jsquash/png/decode";
import decodeWebp from "@jsquash/webp/decode";
import type {
    CompressWorkerRequest,
    CompressWorkerResponse,
    CropRect,
} from "@/workers/compress-worker-types";

type ImageFormat = "jpeg" | "png" | "webp" | "gif" | "heic" | "unknown";

const detectFormat = (bytes: Uint8Array): ImageFormat => {
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return "jpeg";
    }
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
    ) {
        return "png";
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return "webp";
    }
    if (
        bytes.length >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46
    ) {
        return "gif";
    }
    return "unknown";
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
    bytes.slice().buffer;

const mimeForFormat = (format: ImageFormat): string => {
    switch (format) {
        case "jpeg":
            return "image/jpeg";
        case "png":
            return "image/png";
        case "webp":
            return "image/webp";
        case "gif":
            return "image/gif";
        case "heic":
            return "image/heic";
        default:
            return "application/octet-stream";
    }
};

const decodeViaBitmap = async (bytes: Uint8Array, format: ImageFormat): Promise<ImageData> => {
    const blob = new Blob([bytes.slice()], { type: mimeForFormat(format) });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) {
        bitmap.close();
        throw new Error("OffscreenCanvas unavailable");
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height);
};

const decodeToImageData = async (
    bytes: Uint8Array,
    format: ImageFormat,
): Promise<ImageData> => {
    const buffer = toArrayBuffer(bytes);
    if (format === "jpeg") {
        return decodeJpeg(buffer);
    }
    if (format === "png") {
        return decodePng(buffer);
    }
    if (format === "webp") {
        return decodeWebp(buffer);
    }
    return decodeViaBitmap(bytes, format);
};

const cropImageData = async (
    source: ImageData,
    crop: CropRect,
): Promise<ImageData> => {
    const x = Math.max(0, Math.round(crop.x));
    const y = Math.max(0, Math.round(crop.y));
    const width = Math.min(Math.round(crop.width), source.width - x);
    const height = Math.min(Math.round(crop.height), source.height - y);
    const canvas = new OffscreenCanvas(source.width, source.height);
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("OffscreenCanvas unavailable");
    }
    context.putImageData(source, 0, 0);
    const cropped = new OffscreenCanvas(width, height);
    const croppedContext = cropped.getContext("2d");
    if (!croppedContext) {
        throw new Error("OffscreenCanvas unavailable");
    }
    croppedContext.drawImage(canvas, x, y, width, height, 0, 0, width, height);
    return croppedContext.getImageData(0, 0, width, height);
};

const qualitySteps = (targetPercent: number): number[] => {
    const steps: number[] = [];
    for (let quality = targetPercent; quality >= 45; quality -= 10) {
        steps.push(quality);
    }
    return steps;
};

const encodeAtQuality = async (
    imageData: ImageData,
    qualityPercent: number,
): Promise<Uint8Array> => {
    const buffer = await encodeJpeg(imageData, { quality: qualityPercent });
    return new Uint8Array(buffer);
};

const encodeImage = async (
    bytes: Uint8Array,
    quality: number,
    cropRect: CropRect | undefined,
    preferSmaller: boolean,
): Promise<{
    bytes: Uint8Array;
    width: number;
    height: number;
    encodeQuality: number;
}> => {
    const format = detectFormat(bytes);
    let imageData = await decodeToImageData(bytes, format);

    if (cropRect) {
        imageData = await cropImageData(imageData, cropRect);
    }

    const targetPercent = Math.round(Math.min(95, Math.max(45, quality * 100)));
    const steps = preferSmaller ?
        qualitySteps(targetPercent) :
        [targetPercent];

    let bestBytes: Uint8Array | undefined;
    let bestQuality = targetPercent;

    for (const stepQuality of steps) {
        const encoded = await encodeAtQuality(imageData, stepQuality);
        if (!bestBytes || encoded.length < bestBytes.length) {
            bestBytes = encoded;
            bestQuality = stepQuality;
        }
        if (preferSmaller && encoded.length < bytes.length) {
            bestBytes = encoded;
            bestQuality = stepQuality;
            break;
        }
    }

    if (!bestBytes) {
        throw new Error("JPEG encode failed");
    }

    return {
        bytes: bestBytes,
        width: imageData.width,
        height: imageData.height,
        encodeQuality: bestQuality,
    };
};

self.onmessage = async (
    event: MessageEvent<CompressWorkerRequest>,
): Promise<void> => {
    const {
        id,
        bytes,
        quality,
        cropRect,
        preferSmaller = false,
    }: CompressWorkerRequest = event.data;
    try {
        const result = await encodeImage(bytes, quality, cropRect, preferSmaller);
        const response: CompressWorkerResponse = {
            id,
            bytes: result.bytes,
            width: result.width,
            height: result.height,
            encodeQuality: result.encodeQuality,
            encoder: "mozjpeg",
        };
        self.postMessage(response);
    } catch (error: unknown) {
        const response: CompressWorkerResponse = {
            id,
            error: error instanceof Error ? error.message : "Encode failed",
        };
        self.postMessage(response);
    }
};
