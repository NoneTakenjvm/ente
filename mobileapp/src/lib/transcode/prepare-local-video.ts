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
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve();
            };
            const fail = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                reject(new Error("Could not read video metadata"));
            };
            video.onloadedmetadata = finish;
            video.onloadeddata = finish;
            video.onerror = fail;
            video.src = url;
            if (typeof video.load === "function") {
                video.load();
            }
        });
        const rawDuration = video.duration;
        if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
            throw new Error("Could not determine video duration");
        }
        const duration = Math.max(1, Math.round(rawDuration));
        const { videoWidth: width, videoHeight: height } = video;
        if (width <= 0 || height <= 0) {
            throw new Error("Could not determine video dimensions");
        }
        return { width, height, duration };
    } finally {
        URL.revokeObjectURL(url);
    }
};

const isBrowserCompatibleMp4 = (mimeType: string, fileName: string): boolean => {
    if (mimeType === "video/mp4") {
        return true;
    }
    return fileName.toLowerCase().endsWith(".mp4");
};

/**
 * Normalize a device video to MP4 and read dimensions plus duration.
 */
export const prepareLocalVideo = async (file: File): Promise<PreparedLocalVideo> => {
    const inputMime = mimeTypeForVideoFile(file);
    const inputBytes = new Uint8Array(await file.arrayBuffer());
    const inputBlob = new Blob([inputBytes], { type: inputMime });

    if (isBrowserCompatibleMp4(inputMime, file.name)) {
        try {
            const meta = await probeVideoBlob(inputBlob);
            return { bytes: inputBytes, ...meta };
        } catch {
            // Fall through to transcode when probe fails.
        }
    }

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
        inputBlob,
        "mp4",
    );
    const meta = await probeVideoBlob(
        new Blob([Uint8Array.from(output)], { type: "video/mp4" }),
    );
    return { bytes: output, ...meta };
};
