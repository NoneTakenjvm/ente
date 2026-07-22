import { blobFromUint8Array } from "@/lib/bytes-blob";
import { runFFmpeg, terminateFFmpeg } from "@/lib/ffmpeg";
import { logJsHeap } from "@/lib/memory-probe";
import type { RotationDegrees } from "@/lib/rotate";

export interface VideoCropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface VideoTrimRange {
    startSec: number;
    endSec: number;
}

export interface CroppedVideoResult {
    bytes: Uint8Array;
    width: number;
    height: number;
    duration: number;
}

export interface VideoEditOptions {
    crop?: VideoCropRect;
    trim?: VideoTrimRange;
    onProgress?: (ratio: number) => void;
}

const DEFAULT_VIDEO_CRF = "23";

/**
 * libx264 requires even width/height; clamp the crop into the source frame.
 */
export const normalizeVideoCropRect = (
    crop: VideoCropRect,
    sourceDimensions: { width: number; height: number },
): VideoCropRect => {
    const sourceWidth = Math.max(2, Math.floor(sourceDimensions.width));
    const sourceHeight = Math.max(2, Math.floor(sourceDimensions.height));
    let x = Math.max(0, Math.floor(crop.x));
    let y = Math.max(0, Math.floor(crop.y));
    x -= x % 2;
    y -= y % 2;
    let width = Math.max(2, Math.floor(crop.width));
    let height = Math.max(2, Math.floor(crop.height));
    width -= width % 2;
    height -= height % 2;
    if (x + width > sourceWidth) {
        width = Math.max(2, sourceWidth - x);
        width -= width % 2;
    }
    if (y + height > sourceHeight) {
        height = Math.max(2, sourceHeight - y);
        height -= height % 2;
    }
    if (width < 2 || height < 2) {
        return {
            x: 0,
            y: 0,
            width: sourceWidth - (sourceWidth % 2),
            height: sourceHeight - (sourceHeight % 2),
        };
    }
    return { x, y, width, height };
};

export const probeVideoDurationSec = async (
    bytes: Uint8Array,
    mimeType: string,
): Promise<number> => {
    const url = URL.createObjectURL(blobFromUint8Array(bytes, mimeType));
    try {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.playsInline = true;
        video.src = url;
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("Could not read video duration"));
        });
        const duration = Math.round(video.duration);
        if (!Number.isFinite(duration) || duration <= 0) {
            throw new Error("Could not determine video duration");
        }
        return duration;
    } finally {
        URL.revokeObjectURL(url);
    }
};

const transposeFilterForRotation = (degrees: RotationDegrees): string => {
    if (degrees === 90) {
        return "transpose=1";
    }
    if (degrees === 270) {
        return "transpose=2";
    }
    return "transpose=2,transpose=2";
};

const dimensionsAfterRotation = (
    width: number,
    height: number,
    degrees: RotationDegrees,
): { width: number; height: number } => {
    if (degrees === 90 || degrees === 270) {
        return { width: height, height: width };
    }
    return { width, height };
};

const h264Tail = (audioMode: "copy" | "aac" | "none"): string[] => [
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-crf", DEFAULT_VIDEO_CRF,
    "-preset", "ultrafast",
    ...(audioMode === "copy" ?
        ["-c:a", "copy"] :
        audioMode === "aac" ?
            ["-c:a", "aac", "-ac", "2"] :
            ["-an"]),
    "-movflags", "+faststart",
    "OUTPUT",
];

/**
 * Prefer stream-copying audio (cheap). Fall back to AAC, then drop audio.
 */
const runH264Encode = async (
    argsBeforeOutput: string[],
    input: Blob,
    onProgress?: (ratio: number) => void,
): Promise<Uint8Array> => {
    try {
        return await runFFmpeg(
            [...argsBeforeOutput, ...h264Tail("copy")],
            input,
            "mp4",
            onProgress,
        );
    } catch {
        try {
            return await runFFmpeg(
                [...argsBeforeOutput, ...h264Tail("aac")],
                input,
                "mp4",
                onProgress,
            );
        } catch {
            return await runFFmpeg(
                [...argsBeforeOutput, ...h264Tail("none")],
                input,
                "mp4",
                onProgress,
            );
        }
    }
};

/**
 * Rotate video bytes clockwise by the given angle via ffmpeg.
 */
export const rotateVideoBytes = async (
    bytes: Uint8Array,
    mimeType: string,
    degrees: RotationDegrees,
    sourceDimensions: { width: number; height: number },
    onProgress?: (ratio: number) => void,
): Promise<CroppedVideoResult> => {
    logJsHeap("video-rotate:start");
    const input = blobFromUint8Array(bytes, mimeType);
    const output = await runH264Encode(
        ["-i", "INPUT", "-vf", transposeFilterForRotation(degrees)],
        input,
        onProgress,
    );
    const { width, height } = dimensionsAfterRotation(
        sourceDimensions.width,
        sourceDimensions.height,
        degrees,
    );
    // Prefer metadata duration over another full decode when possible.
    let duration: number;
    try {
        duration = await probeVideoDurationSec(output, "video/mp4");
    } catch {
        duration = 1;
    }
    logJsHeap("video-rotate:done");
    void terminateFFmpeg();
    return { bytes: output, width, height, duration };
};

/**
 * Apply spatial crop and/or temporal trim to video bytes via ffmpeg.
 */
export const applyVideoEdits = async (
    bytes: Uint8Array,
    mimeType: string,
    options: VideoEditOptions,
    sourceDimensions: { width: number; height: number },
): Promise<CroppedVideoResult> => {
    logJsHeap("video-edit:start");
    let outputWidth = Math.max(2, Math.floor(sourceDimensions.width));
    let outputHeight = Math.max(2, Math.floor(sourceDimensions.height));
    outputWidth -= outputWidth % 2;
    outputHeight -= outputHeight % 2;

    const vfParts: string[] = [];
    if (options.crop) {
        const crop = normalizeVideoCropRect(options.crop, sourceDimensions);
        vfParts.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
        outputWidth = crop.width;
        outputHeight = crop.height;
    }
    const vf = vfParts.length > 0 ? ["-vf", vfParts.join(",")] : [];
    const input = blobFromUint8Array(bytes, mimeType);

    let output: Uint8Array;
    if (options.trim) {
        const start = Math.max(0, options.trim.startSec);
        const end = Math.max(start + 0.1, options.trim.endSec);
        const duration = Math.max(0.1, end - start);
        output = await runH264Encode(
            ["-ss", String(start), "-t", String(duration), "-i", "INPUT", ...vf],
            input,
            options.onProgress,
        );
    } else {
        output = await runH264Encode(
            ["-i", "INPUT", ...vf],
            input,
            options.onProgress,
        );
    }

    const duration = options.trim ?
        Math.max(1, Math.round(options.trim.endSec - options.trim.startSec)) :
        await probeVideoDurationSec(output, "video/mp4").catch(() => 1);

    logJsHeap("video-edit:done");
    void terminateFFmpeg();
    return {
        bytes: output,
        width: outputWidth,
        height: outputHeight,
        duration,
    };
};

/**
 * Spatially crop a video to the given pixel rectangle via ffmpeg.
 */
export const cropVideoBytes = async (
    bytes: Uint8Array,
    mimeType: string,
    crop: VideoCropRect,
    sourceDimensions: { width: number; height: number },
): Promise<CroppedVideoResult> =>
    applyVideoEdits(bytes, mimeType, { crop }, sourceDimensions);
