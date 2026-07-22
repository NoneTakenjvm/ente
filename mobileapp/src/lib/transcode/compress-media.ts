import type { EnteFile } from "ente-media/file";
import {
    DEFAULT_JPEG_QUALITY,
    DEFAULT_VIDEO_CRF,
    encodeJpegFromBytes,
    type EncodeJpegResult,
} from "@/lib/compress";
import { runFFmpeg, type FFmpegProgressCallback } from "@/lib/ffmpeg";
import { mediaKindForFile, mimeTypeForFile } from "@/lib/media-kind";

export interface CompressMediaResult {
    bytes: Uint8Array;
    width: number;
    height: number;
    duration?: number;
    mimeType: string;
    extension: string;
}

export interface CompressMediaOptions {
    quality: number;
    videoCrf: number;
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

const blobFromBytes = (bytes: Uint8Array, mimeType: string): Blob =>
    new Blob([Uint8Array.from(bytes)], { type: mimeType });

const evenScaleFilter = (maxLongEdge: number): string =>
    `scale='trunc(min(${maxLongEdge}\\,iw)/2)*2':-2`;

/**
 * Compress library media bytes for a derived upload copy.
 *
 * Video encodes use libx264 {@code ultrafast} for mobile wall-clock speed.
 */
export const compressMediaBytes = async (
    file: EnteFile,
    bytes: Uint8Array,
    options: Partial<CompressMediaOptions> = {},
): Promise<CompressMediaResult> => {
    const { quality, videoCrf, maxLongEdge, onProgress } = {
        ...defaultOptions,
        ...options,
    };
    const kind = mediaKindForFile(file);
    const mimeType = mimeTypeForFile(file);

    if (kind === "video") {
        const vf =
            maxLongEdge && maxLongEdge > 0 ?
                ["-vf", evenScaleFilter(maxLongEdge)] :
                [];
        const output = await runFFmpeg(
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
        const sourceW = Number(file.pubMagicMetadata?.data?.w) || 0;
        const sourceH = Number(file.pubMagicMetadata?.data?.h) || 0;
        let width = sourceW;
        let height = sourceH;
        if (maxLongEdge && maxLongEdge > 0 && sourceW > 0 && sourceH > 0) {
            const longEdge = Math.max(sourceW, sourceH);
            if (longEdge > maxLongEdge) {
                const scale = maxLongEdge / longEdge;
                width = Math.max(2, Math.round(sourceW * scale));
                height = Math.max(2, Math.round(sourceH * scale));
                width -= width % 2;
                height -= height % 2;
            }
        }
        return {
            bytes: output,
            width,
            height,
            duration: file.metadata.duration,
            mimeType: "video/mp4",
            extension: "mp4",
        };
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
        };
    }

    const encoded: EncodeJpegResult = await encodeJpegFromBytes(bytes, quality);
    onProgress?.(1);
    return {
        bytes: encoded.bytes,
        width: encoded.width,
        height: encoded.height,
        mimeType: "image/jpeg",
        extension: "jpg",
    };
};
