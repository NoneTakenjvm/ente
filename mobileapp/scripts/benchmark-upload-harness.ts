/**
 * Browser harness: times each upload-pipeline phase (network mocked).
 * Bundled and evaluated inside Playwright — see benchmark-upload-pipeline.ts.
 */
import {
    chunkHashFinal,
    chunkHashInit,
    chunkHashUpdate,
    encryptStreamBytes,
    generateBlobOrStreamKey,
} from "ente-base/crypto";
import { prepareLocalVideo } from "../src/lib/transcode/prepare-local-video";
import { extractVideoFrameJpeg } from "../src/lib/ffmpeg";
import { generateImageThumbnail } from "../src/core/upload/thumbnail";
import { encodeJpegFromBytes } from "../src/lib/compress";

export interface PhaseTiming {
    phase: string;
    ms: number;
    bytes?: number;
}

const now = (): number => performance.now();

const log = (message: string, data?: Record<string, unknown>): void => {
    console.log(`[bench] ${message}`, data ?? "");
};

const timePhase = async <T>(
    phase: string,
    fn: () => Promise<T>,
    bytes?: number,
): Promise<{ result: T; timing: PhaseTiming }> => {
    const start = now();
    const result = await fn();
    return { result, timing: { phase, ms: now() - start, bytes } };
};

const hashBytes = async (data: Uint8Array): Promise<string> => {
    const hashState = await chunkHashInit();
    await chunkHashUpdate(hashState, data);
    return chunkHashFinal(hashState);
};

export const benchmarkVideoUpload = async (
    file: File,
): Promise<PhaseTiming[]> => {
    const timings: PhaseTiming[] = [];
    log("video start", { name: file.name, size: file.size });

    const read = await timePhase("readFile.arrayBuffer", async () => {
        return new Uint8Array(await file.arrayBuffer());
    }, file.size);
    timings.push(read.timing);
    log("read done", { ms: read.timing.ms });

    const prepared = await timePhase("prepareLocalVideo", async () => {
        return prepareLocalVideo(file);
    }, file.size);
    timings.push(prepared.timing);
    log("prepare done", { ms: prepared.timing.ms, bytes: prepared.result.bytes.length });

    const frame = await timePhase("extractVideoFrameJpeg", async () => {
        return extractVideoFrameJpeg(prepared.result.bytes, "video/mp4");
    }, prepared.result.bytes.length);
    timings.push(frame.timing);
    log("frame done", { ms: frame.timing.ms });

    const thumb = await timePhase("generateImageThumbnail", async () => {
        return generateImageThumbnail(frame.result);
    });
    timings.push(thumb.timing);
    log("thumb done", { ms: thumb.timing.ms });

    const hash = await timePhase("contentHash", async () => {
        return hashBytes(prepared.result.bytes);
    }, prepared.result.bytes.length);
    timings.push(hash.timing);
    log("hash done", { ms: hash.timing.ms });

    const encrypt = await timePhase("encryptStreamBytes", async () => {
        const key = await generateBlobOrStreamKey();
        return encryptStreamBytes(prepared.result.bytes, key);
    }, prepared.result.bytes.length);
    timings.push(encrypt.timing);
    log("encrypt done", { ms: encrypt.timing.ms });

    return timings;
};

export const benchmarkImageUpload = async (
    file: File,
): Promise<PhaseTiming[]> => {
    const timings: PhaseTiming[] = [];

    const read = await timePhase("readFile.arrayBuffer", async () => {
        return new Uint8Array(await file.arrayBuffer());
    }, file.size);
    timings.push(read.timing);

    const encoded = await timePhase("encodeJpegFromBytes", async () => {
        return encodeJpegFromBytes(read.result, 0.85);
    }, file.size);
    timings.push(encoded.timing);

    const thumb = await timePhase("generateImageThumbnail", async () => {
        return generateImageThumbnail(encoded.result.bytes);
    });
    timings.push(thumb.timing);

    const hash = await timePhase("contentHash", async () => {
        return hashBytes(encoded.result.bytes);
    }, encoded.result.bytes.length);
    timings.push(hash.timing);

    const encrypt = await timePhase("encryptStreamBytes", async () => {
        const key = await generateBlobOrStreamKey();
        return encryptStreamBytes(encoded.result.bytes, key);
    }, encoded.result.bytes.length);
    timings.push(encrypt.timing);

    return timings;
};
