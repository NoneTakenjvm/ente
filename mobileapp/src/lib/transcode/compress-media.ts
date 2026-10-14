import type { EnteFile } from "ente-media/file";
import {
    DEFAULT_JPEG_QUALITY,
    DEFAULT_VIDEO_CRF,
    encodeCompressedStillFromBytes,
} from "@/lib/compress";
import { runFFmpeg, type FFmpegProgressCallback } from "@/lib/ffmpeg";
import { mediaKindForFile, mimeTypeForFile } from "@/lib/media-kind";
import { evenOutputSize } from "@/lib/transcode/even-output-size";

export type CompressEncoder = "webcodecs" | "ffmpeg" | "photohoard";

/** `kept` = source audio copied or re-encoded into the output. */
export type CompressAudioOutcome = "kept" | "none";

export interface CompressMediaResult {
    bytes: Uint8Array;
    width: number;
    height: number;
    duration?: number;
    mimeType: string;
    extension: string;
    /** Which encoder produced this output. */
    encoder: CompressEncoder;
    /** How audio was handled for videos (`none` for stills / silent clips). */
    audio: CompressAudioOutcome;
}

export interface CompressMediaOptions {
    quality: number;
    videoCrf: number;
    minSizeBytes?: number;
    /**
     * When set, scale video so the long edge is at most this many pixels
     * (even dimensions). Used for faster previews / smaller outputs.
     */
    maxLongEdge?: number;
    /** Checked between encoding stages; an aborted run rejects with its reason. */
    signal?: AbortSignal;
    onProgress?: FFmpegProgressCallback;
}

const defaultOptions: CompressMediaOptions = {
    quality: DEFAULT_JPEG_QUALITY,
    videoCrf: DEFAULT_VIDEO_CRF,
};

/** Default long-edge cap for interactive video compression previews. */
export const VIDEO_COMPRESS_PREVIEW_MAX_LONG_EDGE = 1280;

/** Default long-edge cap for Manage batch video compression. */
export const VIDEO_COMPRESS_BATCH_MAX_LONG_EDGE = 1920;

const blobFromBytes = (bytes: Uint8Array, mimeType: string): Blob =>
    new Blob([Uint8Array.from(bytes)], { type: mimeType });

/** Fit inside a square of `maxLongEdge` (either orientation), never upscale, even sides. */
const evenScaleFilter = (maxLongEdge: number): string =>
    `scale=w='min(${maxLongEdge},iw)':h='min(${maxLongEdge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;

const videoOutputSize = (
    file: EnteFile,
    maxLongEdge?: number,
): { width: number; height: number } => {
    const sourceW = Number(file.pubMagicMetadata?.data?.w) || 0;
    const sourceH = Number(file.pubMagicMetadata?.data?.h) || 0;
    if (sourceW <= 0 || sourceH <= 0) {
        return { width: sourceW, height: sourceH };
    }
    return evenOutputSize(sourceW, sourceH, maxLongEdge);
};

const compressVideoWithFfmpeg = async (
    bytes: Uint8Array,
    mimeType: string,
    videoCrf: number,
    maxLongEdge: number | undefined,
    onProgress?: FFmpegProgressCallback,
): Promise<Uint8Array> => {
    const vf =
        maxLongEdge && maxLongEdge > 0 ?
            ["-vf", evenScaleFilter(maxLongEdge)] :
            [];
    return runFFmpeg(
        [
            "-i", "INPUT",
            ...vf,
            "-c:v", "libx264",
            "-crf", String(videoCrf),
            "-preset", "ultrafast",
            "-c:a", "aac",
            "-movflags", "+faststart",
            "OUTPUT",
        ],
        blobFromBytes(bytes, mimeType),
        "mp4",
        onProgress,
    );
};

/**
 * Compress library media bytes for a derived upload copy.
 *
 * Videos try hardware {@link VideoEncoder} H.264 first (audio copied or
 * re-encoded alongside). When WebCodecs cannot convert every audio/video track,
 * ffmpeg libx264 re-encodes the whole file instead — never a silent MP4.
 */
export const compressMediaBytes = async (
    file: EnteFile,
    bytes: Uint8Array,
    options: Partial<CompressMediaOptions> = {},
): Promise<CompressMediaResult> => {
    const result = await encodeMediaBytes(file, bytes, options);
    options.signal?.throwIfAborted();
    return result;
};

const encodeMediaBytes = async (
    file: EnteFile,
    bytes: Uint8Array,
    options: Partial<CompressMediaOptions>,
): Promise<CompressMediaResult> => {
    const {
        quality,
        videoCrf,
        maxLongEdge,
        minSizeBytes = 0,
        signal,
        onProgress,
    } = {
        ...defaultOptions,
        ...options,
    };
    signal?.throwIfAborted();
    const kind = mediaKindForFile(file);
    const mimeType = mimeTypeForFile(file);

    if (kind === "video") {
        try {
            // Lazy so mediabunny stays out of the initial chunk (/manage).
            const { encodeH264WebCodecs } = await import(
                "@/lib/transcode/webcodecs-h264"
            );
            const encoded = await encodeH264WebCodecs({
                bytes,
                videoCrf,
                maxLongEdge,
                onProgress,
            });
            return {
                bytes: encoded.bytes,
                width: encoded.width,
                height: encoded.height,
                duration: encoded.duration,
                mimeType: "video/mp4",
                extension: "mp4",
                encoder: "webcodecs",
                audio: encoded.hasAudio ? "kept" : "none",
            };
        } catch {
            // Don't start the slow ffmpeg fallback for a paused or stopped job.
            signal?.throwIfAborted();
            const output = await compressVideoWithFfmpeg(
                bytes,
                mimeType,
                videoCrf,
                maxLongEdge,
                onProgress,
            );
            const size = videoOutputSize(file, maxLongEdge);
            return {
                bytes: output,
                width: size.width,
                height: size.height,
                duration: file.metadata.duration,
                mimeType: "video/mp4",
                extension: "mp4",
                encoder: "ffmpeg",
                audio: "kept",
            };
        }
    }

    if (kind === "gif") {
        const scale = quality < 0.75 ? "320:-1" : "480:-1";
        const output = await runFFmpeg(
            [
                "-i", "INPUT",
                "-vf", `fps=15,scale=${scale}:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
                "OUTPUT",
            ],
            blobFromBytes(bytes, "image/gif"),
            "gif",
            onProgress,
        );
        return {
            bytes: output,
            width: file.pubMagicMetadata?.data?.w as number ?? 0,
            height: file.pubMagicMetadata?.data?.h as number ?? 0,
            mimeType: "image/gif",
            extension: "gif",
            encoder: "ffmpeg",
            audio: "none",
        };
    }

    const encoded = await encodeCompressedStillFromBytes(bytes, minSizeBytes);
    onProgress?.(1);
    return {
        bytes: encoded.bytes,
        width: encoded.width,
        height: encoded.height,
        mimeType: encoded.mimeType,
        extension: encoded.extension,
        encoder: "photohoard",
        audio: "none",
    };
};
