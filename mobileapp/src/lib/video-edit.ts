import { runFFmpeg } from "@/lib/ffmpeg";
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
}

const DEFAULT_VIDEO_CRF = "23";

export const probeVideoDurationSec = async (
    bytes: Uint8Array,
    mimeType: string,
): Promise<number> => {
    const url = URL.createObjectURL(
        new Blob([Uint8Array.from(bytes)], { type: mimeType }),
    );
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

const encodeVideo = async (
    args: string[],
    input: Blob,
): Promise<Uint8Array> =>
    runFFmpeg(
        [
            ...args,
            "-c:v", "libx264",
            "-crf", DEFAULT_VIDEO_CRF,
            "-preset", "fast",
            "-c:a", "aac",
            "-movflags", "+faststart",
            "OUTPUT",
        ],
        input,
        "mp4",
    );

/**
 * Rotate video bytes clockwise by the given angle via ffmpeg.
 */
export const rotateVideoBytes = async (
    bytes: Uint8Array,
    mimeType: string,
    degrees: RotationDegrees,
    sourceDimensions: { width: number; height: number },
): Promise<CroppedVideoResult> => {
    const output = await encodeVideo(
        ["-i", "INPUT", "-vf", transposeFilterForRotation(degrees)],
        new Blob([Uint8Array.from(bytes)], { type: mimeType }),
    );
    const { width, height } = dimensionsAfterRotation(
        sourceDimensions.width,
        sourceDimensions.height,
        degrees,
    );
    const duration = await probeVideoDurationSec(output, "video/mp4");
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
    const args: string[] = ["-i", "INPUT"];

    if (options.trim) {
        args.push("-ss", String(options.trim.startSec));
        args.push("-to", String(options.trim.endSec));
    }

    if (options.crop) {
        const { x, y, width, height } = options.crop;
        args.push("-vf", `crop=${width}:${height}:${x}:${y}`);
    }

    const output = await encodeVideo(
        args,
        new Blob([Uint8Array.from(bytes)], { type: mimeType }),
    );

    const width = options.crop?.width ?? sourceDimensions.width;
    const height = options.crop?.height ?? sourceDimensions.height;
    const duration = options.trim ?
        Math.max(1, Math.round(options.trim.endSec - options.trim.startSec)) :
        await probeVideoDurationSec(output, "video/mp4");

    return { bytes: output, width, height, duration };
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
