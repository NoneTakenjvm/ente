import { runFFmpeg } from "@/lib/ffmpeg";

export interface VideoCropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface CroppedVideoResult {
    bytes: Uint8Array;
    width: number;
    height: number;
}

/**
 * Spatially crop a video to the given pixel rectangle via ffmpeg.
 */
export const cropVideoBytes = async (
    bytes: Uint8Array,
    mimeType: string,
    crop: VideoCropRect,
): Promise<CroppedVideoResult> => {
    const { x, y, width, height } = crop;
    const output = await runFFmpeg(
        [
            "-i", "INPUT",
            "-vf", `crop=${width}:${height}:${x}:${y}`,
            "-c:v", "libx264",
            "-crf", "23",
            "-preset", "fast",
            "-c:a", "aac",
            "-movflags", "+faststart",
            "OUTPUT",
        ],
        new Blob([Uint8Array.from(bytes)], { type: mimeType }),
        "mp4",
    );
    return { bytes: output, width, height };
};
