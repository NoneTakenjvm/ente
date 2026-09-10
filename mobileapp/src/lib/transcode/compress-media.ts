import type { EnteFile } from "ente-media/file";
import {
    CompressionSkippedError,
    DEFAULT_JPEG_QUALITY,
    DEFAULT_VIDEO_CRF,
    encodeCompressedStillFromBytes,
} from "@/lib/compress";
import { runFFmpeg, type FFmpegProgressCallback } from "@/lib/ffmpeg";
import { mediaKindForFile, mimeTypeForFile } from "@/lib/media-kind";
import {
    encodeH264WebCodecs,
    evenOutputSize,
} from "@/lib/transcode/webcodecs-h264";

export type CompressEncoder = "webcodecs" | "ffmpeg" | "photohoard";

export type CompressAudioOutcome = "aac" | "ffmpeg-remux" | "none";
// ffmpeg-remux = original audio copied (preferred) or AAC-reencoded onto HW video

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

const evenScaleFilter = (maxLongEdge: number): string =>
    `scale='trunc(min(${maxLongEdge}\\,iw)/2)*2':-2`;

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
 * Remux WebCodecs video with audio from the original file.
 *
 * Prefer {@code -c:a copy} (original audio, no re-encode). Fall back to AAC
 * only when the container/codec cannot be copied into MP4.
 */
const remuxWebCodecsAudio = async (
    videoOnlyBytes: Uint8Array,
    originalBytes: Uint8Array,
    originalMime: string,
    onProgress?: FFmpegProgressCallback,
): Promise<Uint8Array> => {
    try {
        return await runFFmpeg(
            [
                "-i", "INPUT0",
                "-i", "INPUT1",
                "-map", "0:v:0",
                "-map", "1:a:0?",
                "-c:v", "copy",
                "-c:a", "copy",
                "-shortest",
                "-movflags", "+faststart",
                "OUTPUT",
            ],
            [
                blobFromBytes(videoOnlyBytes, "video/mp4"),
                blobFromBytes(originalBytes, originalMime),
            ],
            "mp4",
            onProgress,
        );
    } catch {
        return runFFmpeg(
            [
                "-i", "INPUT0",
                "-i", "INPUT1",
                "-map", "0:v:0",
                "-map", "1:a:0?",
                "-c:v", "copy",
                "-c:a", "aac",
                "-shortest",
                "-movflags", "+faststart",
                "OUTPUT",
            ],
            [
                blobFromBytes(videoOnlyBytes, "video/mp4"),
                blobFromBytes(originalBytes, originalMime),
            ],
            "mp4",
            onProgress,
        );
    }
};

/**
 * Compress library media bytes for a derived upload copy.
 *
 * Videos try hardware {@link VideoEncoder} H.264 first. When the source has
 * audio that WebCodecs cannot encode, ffmpeg remuxes audio onto the hardware
 * video. If remux also fails, the file is skipped (never replaced with a silent
 * MP4). Full ffmpeg libx264 is only used when VideoEncoder cannot encode video.
 */
export const compressMediaBytes = async (
    file: EnteFile,
    bytes: Uint8Array,
    options: Partial<CompressMediaOptions> = {},
): Promise<CompressMediaResult> => {
    const { quality, videoCrf, maxLongEdge, minSizeBytes = 0, onProgress } = {
        ...defaultOptions,
        ...options,
    };
    const kind = mediaKindForFile(file);
    const mimeType = mimeTypeForFile(file);

    if (kind === "video") {
        try {
            const encoded = await encodeH264WebCodecs({
                bytes,
                mimeType,
                videoCrf,
                maxLongEdge,
                onProgress,
            });
            let outputBytes = encoded.bytes;
            let audio: CompressAudioOutcome =
                encoded.audio === "aac" ?
                    "aac" :
                    encoded.audio === "none" ?
                        "none" :
                        "aac";

            if (encoded.audio === "needs-remux") {
                try {
                    outputBytes = await remuxWebCodecsAudio(
                        encoded.bytes,
                        bytes,
                        mimeType,
                        onProgress,
                    );
                    audio = "ffmpeg-remux";
                } catch {
                    throw new CompressionSkippedError(
                        "Could not keep audio — skipped",
                    );
                }
            }

            return {
                bytes: outputBytes,
                width: encoded.width,
                height: encoded.height,
                duration: encoded.duration,
                mimeType: "video/mp4",
                extension: "mp4",
                encoder: "webcodecs",
                audio,
            };
        } catch (error: unknown) {
            if (error instanceof CompressionSkippedError) {
                throw error;
            }
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
                audio: "aac",
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
