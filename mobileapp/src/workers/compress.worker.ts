/// <reference lib="webworker" />

import decodeJpeg from "@jsquash/jpeg/decode";
import encodeJpeg from "@jsquash/jpeg/encode";
import decodePng from "@jsquash/png/decode";
import decodeWebp from "@jsquash/webp/decode";
import encodeWebp from "@jsquash/webp/encode";
import encodeAvif from "@jsquash/avif/encode";
import {
    ANALYSIS_MAX,
    analyzeImageData,
    avifQualityForPreset,
    mimeTypeForPreset,
    routeFromFeatures,
    type CompressImagePreset,
} from "@/lib/compress-classify";
import { arrayBufferFromUint8Array } from "@/lib/bytes-blob";
import type {
    CompressWorkerRequest,
    CompressWorkerResponse,
    CropRect,
} from "@/workers/compress-worker-types";

type ImageFormat = "jpeg" | "png" | "webp" | "gif" | "heic" | "avif" | "unknown";

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
    if (bytes.length >= 12) {
        const brand = String.fromCharCode(
            bytes[4] ?? 0,
            bytes[5] ?? 0,
            bytes[6] ?? 0,
            bytes[7] ?? 0,
        );
        if (brand === "ftyp") {
            const subtype = String.fromCharCode(
                bytes[8] ?? 0,
                bytes[9] ?? 0,
                bytes[10] ?? 0,
                bytes[11] ?? 0,
            );
            if (subtype.startsWith("avif") || subtype.startsWith("avis")) {
                return "avif";
            }
            if (
                subtype.startsWith("heic") ||
                subtype.startsWith("heix") ||
                subtype.startsWith("mif1")
            ) {
                return "heic";
            }
        }
    }
    return "unknown";
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
    arrayBufferFromUint8Array(bytes);

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
        case "avif":
            return "image/avif";
        default:
            return "application/octet-stream";
    }
};

const decodeViaBitmap = async (
    bytes: Uint8Array,
    format: ImageFormat,
): Promise<ImageData> => {
    const blob = new Blob([toArrayBuffer(bytes)], { type: mimeForFormat(format) });
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
    try {
        return await decodeViaBitmap(bytes, format);
    } catch {
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
        throw new Error("Could not decode image");
    }
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

const downsampleForAnalysis = async (source: ImageData): Promise<ImageData> => {
    const longEdge = Math.max(source.width, source.height);
    if (longEdge <= ANALYSIS_MAX) {
        return source;
    }
    const scale = ANALYSIS_MAX / longEdge;
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = new OffscreenCanvas(source.width, source.height);
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("OffscreenCanvas unavailable");
    }
    context.putImageData(source, 0, 0);
    const scaled = new OffscreenCanvas(width, height);
    const scaledContext = scaled.getContext("2d");
    if (!scaledContext) {
        throw new Error("OffscreenCanvas unavailable");
    }
    scaledContext.drawImage(canvas, 0, 0, width, height);
    return scaledContext.getImageData(0, 0, width, height);
};

const qualitySteps = (targetPercent: number): number[] => {
    const steps: number[] = [];
    for (let quality = targetPercent; quality >= 45; quality -= 10) {
        steps.push(quality);
    }
    return steps;
};

const encodeAtJpegQuality = async (
    imageData: ImageData,
    qualityPercent: number,
): Promise<Uint8Array> => {
    const buffer = await encodeJpeg(imageData, { quality: qualityPercent });
    return new Uint8Array(buffer);
};

const encodeJpegImage = async (
    imageData: ImageData,
    quality: number,
    originalLength: number,
    preferSmaller: boolean,
): Promise<{ bytes: Uint8Array; encodeQuality: number }> => {
    const targetPercent = Math.round(Math.min(95, Math.max(45, quality * 100)));
    const steps = preferSmaller ? qualitySteps(targetPercent) : [targetPercent];
    let bestBytes: Uint8Array | undefined;
    let bestQuality = targetPercent;

    for (const stepQuality of steps) {
        const encoded = await encodeAtJpegQuality(imageData, stepQuality);
        if (!bestBytes || encoded.length < bestBytes.length) {
            bestBytes = encoded;
            bestQuality = stepQuality;
        }
        if (preferSmaller && encoded.length < originalLength) {
            bestBytes = encoded;
            bestQuality = stepQuality;
            break;
        }
    }

    if (!bestBytes) {
        throw new Error("JPEG encode failed");
    }
    return { bytes: bestBytes, encodeQuality: bestQuality };
};

let nativeAvif: boolean | undefined;

const canEncodeAvifNative = async (): Promise<boolean> => {
    if (nativeAvif !== undefined) {
        return nativeAvif;
    }
    try {
        const canvas = new OffscreenCanvas(2, 2);
        const blob = await canvas.convertToBlob({ type: "image/avif", quality: 0.6 });
        nativeAvif = blob.type.includes("avif");
    } catch {
        nativeAvif = false;
    }
    return nativeAvif;
};

const encodeAvifNative = async (
    imageData: ImageData,
    quality: number,
): Promise<Uint8Array> => {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("OffscreenCanvas unavailable");
    }
    context.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({
        type: "image/avif",
        quality: quality / 100,
    });
    if (!blob.type.includes("avif")) {
        throw new Error("Native AVIF encode unavailable");
    }
    return new Uint8Array(await blob.arrayBuffer());
};

const encodeAvifImage = async (
    imageData: ImageData,
    quality: number,
): Promise<Uint8Array> => {
    if (await canEncodeAvifNative()) {
        try {
            return await encodeAvifNative(imageData, quality);
        } catch {
            // fall through to WASM
        }
    }
    const buffer = await encodeAvif(imageData, { quality, speed: 8 });
    return new Uint8Array(buffer);
};

const encodeLosslessWebpNative = async (imageData: ImageData): Promise<Uint8Array> => {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("OffscreenCanvas unavailable");
    }
    context.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 1 });
    if (!blob.type.includes("webp")) {
        throw new Error("Native WebP encode unavailable");
    }
    return new Uint8Array(await blob.arrayBuffer());
};

const encodeLosslessWebp = async (imageData: ImageData): Promise<Uint8Array> => {
    try {
        return await encodeLosslessWebpNative(imageData);
    } catch {
        const buffer = await encodeWebp(imageData, { lossless: 1 });
        return new Uint8Array(buffer);
    }
};

const encodePreset = async (
    imageData: ImageData,
    preset: Exclude<CompressImagePreset, "skip">,
): Promise<{ bytes: Uint8Array; mimeType: string; extension: string; encoder: string }> => {
    const { mimeType, extension } = mimeTypeForPreset(preset);
    if (preset === "lossless-webp") {
        const bytes = await encodeLosslessWebp(imageData);
        return { bytes, mimeType, extension, encoder: "webp" };
    }
    const quality = avifQualityForPreset(preset) ?? 60;
    try {
        const bytes = await encodeAvifImage(imageData, quality);
        return { bytes, mimeType, extension, encoder: "avif" };
    } catch {
        const jpeg = await encodeJpegImage(imageData, 0.85, Number.POSITIVE_INFINITY, false);
        return {
            bytes: jpeg.bytes,
            mimeType: "image/jpeg",
            extension: "jpg",
            encoder: "mozjpeg",
        };
    }
};

const transferResponse = (response: CompressWorkerResponse): void => {
    if (response.bytes) {
        const buffer = toArrayBuffer(response.bytes);
        const transferred: CompressWorkerResponse = {
            ...response,
            bytes: new Uint8Array(buffer),
        };
        self.postMessage(transferred, { transfer: [buffer] });
        return;
    }
    self.postMessage(response);
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
        output = cropRect ? "jpeg" : "auto",
        minSizeBytes = 0,
    }: CompressWorkerRequest = event.data;
    try {
        const format = detectFormat(bytes);
        let imageData = await decodeToImageData(bytes, format);
        if (cropRect) {
            imageData = await cropImageData(imageData, cropRect);
        }

        if (output === "jpeg") {
            const encoded = await encodeJpegImage(
                imageData,
                quality,
                bytes.length,
                preferSmaller,
            );
            transferResponse({
                id,
                bytes: encoded.bytes,
                width: imageData.width,
                height: imageData.height,
                encodeQuality: encoded.encodeQuality,
                encoder: "mozjpeg",
                mimeType: "image/jpeg",
                extension: "jpg",
            });
            return;
        }

        const analysis = await downsampleForAnalysis(imageData);
        const features = analyzeImageData(
            analysis,
            bytes.length,
            imageData.width,
            imageData.height,
        );
        const decision = routeFromFeatures(features, minSizeBytes);
        if (decision.preset === "skip") {
            transferResponse({
                id,
                skipped: true,
                width: imageData.width,
                height: imageData.height,
            });
            return;
        }

        const encoded = await encodePreset(imageData, decision.preset);
        transferResponse({
            id,
            bytes: encoded.bytes,
            width: imageData.width,
            height: imageData.height,
            encoder: encoded.encoder,
            mimeType: encoded.mimeType,
            extension: encoded.extension,
        });
    } catch (error: unknown) {
        const response: CompressWorkerResponse = {
            id,
            error: error instanceof Error ? error.message : "Encode failed",
        };
        self.postMessage(response);
    }
};
