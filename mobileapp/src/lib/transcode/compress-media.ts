import type { EnteFile } from "ente-media/file";
import {
    DEFAULT_JPEG_QUALITY,
    DEFAULT_VIDEO_CRF,
    encodeJpegFromBytes,
    type EncodeJpegResult,
} from "@/lib/compress";
import { runFFmpeg } from "@/lib/ffmpeg";
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
}

const defaultOptions: CompressMediaOptions = {
    quality: DEFAULT_JPEG_QUALITY,
    videoCrf: DEFAULT_VIDEO_CRF,
};

const blobFromBytes = (bytes: Uint8Array, mimeType: string): Blob =>
    new Blob([Uint8Array.from(bytes)], { type: mimeType });

/**
 * Compress library media bytes for a derived upload copy.
 */
export const compressMediaBytes = async (
    file: EnteFile,
    bytes: Uint8Array,
    options: Partial<CompressMediaOptions> = {},
): Promise<CompressMediaResult> => {
    const { quality, videoCrf } = { ...defaultOptions, ...options };
    const kind = mediaKindForFile(file);
    const mimeType = mimeTypeForFile(file);

    if (kind === "video") {
        const output = await runFFmpeg(
            [
                "-i", "INPUT",
                "-c:v", "libx264",
                "-crf", String(videoCrf),
                "-preset", "fast",
                "-c:a", "aac",
                "-movflags", "+faststart",
                "OUTPUT",
            ],
            blobFromBytes(bytes, mimeType),
            "mp4",
        );
        return {
            bytes: output,
            width: file.pubMagicMetadata?.data?.w as number ?? 0,
            height: file.pubMagicMetadata?.data?.h as number ?? 0,
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
    return {
        bytes: encoded.bytes,
        width: encoded.width,
        height: encoded.height,
        mimeType: "image/jpeg",
        extension: "jpg",
    };
};
