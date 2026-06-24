import { FFFSType, FFmpeg } from "@ffmpeg/ffmpeg";
import { PromiseQueue } from "ente-utils/promise";

const CORE_BASE = "https://assets.ente.com/ffmpeg-core-0.12.10/";

let ffmpegPromise: Promise<FFmpeg> | undefined;
const taskQueue = new PromiseQueue<Uint8Array>();

const randomId = (prefix: string): string =>
    `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

const getFFmpeg = (): Promise<FFmpeg> => {
    if (!ffmpegPromise) {
        ffmpegPromise = (async (): Promise<FFmpeg> => {
            const ffmpeg = new FFmpeg();
            await ffmpeg.load({
                coreURL: `${CORE_BASE}ffmpeg-core.js`,
                wasmURL: `${CORE_BASE}ffmpeg-core.wasm`,
            });
            return ffmpeg;
        })();
    }
    return ffmpegPromise;
};

/**
 * Run an ffmpeg command on a blob and return the output file bytes.
 */
export const runFFmpeg = async (
    args: string[],
    input: Blob,
    outputExtension: string,
): Promise<Uint8Array> =>
    taskQueue.add(async (): Promise<Uint8Array> => {
        const ffmpeg = await getFFmpeg();
        const mountDir = "/mount";
        const inputName = randomId("in_");
        const inputPath = `${mountDir}/${inputName}`;
        const outputPath = randomId("out_") + (outputExtension ? `.${outputExtension}` : "");

        try {
            await ffmpeg.createDir(mountDir);
            await ffmpeg.mount(
                FFFSType.WORKERFS,
                { files: [new File([input], inputName)] },
                mountDir,
            );

            const resolvedArgs = args.map((arg) => {
                if (arg === "INPUT") {
                    return inputPath;
                }
                if (arg === "OUTPUT") {
                    return outputPath;
                }
                return arg;
            });

            const status = await ffmpeg.exec(resolvedArgs);
            if (status !== 0) {
                throw new Error(`ffmpeg exited with code ${status}`);
            }

            const result = await ffmpeg.readFile(outputPath);
            if (typeof result === "string") {
                throw new Error("Expected binary ffmpeg output");
            }
            return new Uint8Array(result);
        } finally {
            try {
                await ffmpeg.deleteFile(outputPath);
            } catch {
                // output may not exist on failure
            }
            try {
                await ffmpeg.unmount(mountDir);
            } catch {
                // ignore
            }
            try {
                await ffmpeg.deleteDir(mountDir);
            } catch {
                // ignore
            }
        }
    }) as Promise<Uint8Array>;

/**
 * Extract a poster frame using the browser video decoder (reliable on mobile).
 */
const extractVideoFrameViaCanvas = async (
    videoBytes: Uint8Array,
    mimeType: string,
): Promise<Uint8Array> => {
    const url = URL.createObjectURL(
        new Blob([Uint8Array.from(videoBytes)], { type: mimeType }),
    );
    try {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        video.src = url;
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("Video frame decode failed"));
        });
        if (video.videoWidth <= 0 || video.videoHeight <= 0) {
            throw new Error("Video frame dimensions unavailable");
        }
        const seekTime =
            Number.isFinite(video.duration) && video.duration > 0 ?
                Math.min(0.1, video.duration / 2) :
                0;
        if (seekTime > 0) {
            video.currentTime = seekTime;
            await new Promise<void>((resolve, reject) => {
                video.onseeked = () => resolve();
                video.onerror = () => reject(new Error("Video seek failed"));
            });
        }
        try {
            await video.play();
            video.pause();
        } catch {
            // Muted inline play may be blocked; seeked frame is often enough.
        }
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Canvas unavailable");
        }
        context.drawImage(video, 0, 0);
        const jpegBlob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
                (blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error("JPEG encode failed"));
                    }
                },
                "image/jpeg",
                0.85,
            );
        });
        return new Uint8Array(await jpegBlob.arrayBuffer());
    } finally {
        URL.revokeObjectURL(url);
    }
};

/**
 * Extract a single JPEG frame from video bytes for thumbnails.
 */
export const extractVideoFrameJpeg = async (
    videoBytes: Uint8Array,
    mimeType: string,
): Promise<Uint8Array> => {
    const preferCanvas =
        typeof window !== "undefined" && "ontouchstart" in window;
    if (preferCanvas) {
        return extractVideoFrameViaCanvas(videoBytes, mimeType);
    }
    try {
        return await runFFmpeg(
            ["-i", "INPUT", "-frames:v", "1", "-q:v", "2", "OUTPUT"],
            new Blob([Uint8Array.from(videoBytes)], { type: mimeType }),
            "jpg",
        );
    } catch {
        return extractVideoFrameViaCanvas(videoBytes, mimeType);
    }
};
