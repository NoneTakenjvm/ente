import { DEFAULT_VIDEO_CRF } from "@/lib/compress";
import { runFFmpeg } from "@/lib/ffmpeg";

export interface PreparedLocalVideo {
    bytes: Uint8Array;
    width: number;
    height: number;
    duration: number;
}

const mimeTypeForVideoFile = (file: File): string => {
    if (file.type.startsWith("video/")) {
        return file.type;
    }
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".mov")) {
        return "video/quicktime";
    }
    if (lower.endsWith(".webm")) {
        return "video/webm";
    }
    return "video/mp4";
};

const probeVideoBlob = async (
    blob: Blob,
): Promise<{ width: number; height: number; duration: number }> => {
    const url = URL.createObjectURL(blob);
    try {
        const video = document.createElement("video");
        video.preload = "metadata";
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("Could not read video metadata"));
            video.src = url;
        });
        const duration = Math.round(video.duration);
        if (!Number.isFinite(duration) || duration <= 0) {
            throw new Error("Could not determine video duration");
        }
        const { videoWidth: width, videoHeight: height } = video;
        if (width <= 0 || height <= 0) {
            throw new Error("Could not determine video dimensions");
        }
        return { width, height, duration };
    } finally {
        URL.revokeObjectURL(url);
    }
};

/**
 * Normalize a device video to MP4 and read dimensions plus duration.
 */
export const prepareLocalVideo = async (file: File): Promise<PreparedLocalVideo> => {
    const inputMime = mimeTypeForVideoFile(file);
    const inputBytes = new Uint8Array(await file.arrayBuffer());
    const output = await runFFmpeg(
        [
            "-i", "INPUT",
            "-c:v", "libx264",
            "-crf", String(DEFAULT_VIDEO_CRF),
            "-preset", "fast",
            "-c:a", "aac",
            "-movflags", "+faststart",
            "OUTPUT",
        ],
        new Blob([inputBytes], { type: inputMime }),
        "mp4",
    );
    const meta = await probeVideoBlob(
        new Blob([Uint8Array.from(output)], { type: "video/mp4" }),
    );
    return { bytes: output, ...meta };
};
