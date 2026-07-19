import { FFFSType, FFmpeg } from "@ffmpeg/ffmpeg";
import { PromiseQueue } from "ente-utils/promise";
import { blobFromUint8Array } from "@/lib/bytes-blob";
import { logJsHeap } from "@/lib/memory-probe";

const CORE_BASE = "https://assets.ente.com/ffmpeg-core-0.12.10/";
/** Reclaim the WASM heap shortly after the last job (mobile Chrome). */
const FFMPEG_IDLE_TERMINATE_MS = 2_500;
const THUMB_FRAME_MAX_EDGE = 512;

let ffmpegPromise: Promise<FFmpeg> | undefined;
const taskQueue = new PromiseQueue<Uint8Array>();
let idleTerminateTimer: ReturnType<typeof setTimeout> | undefined;

const randomId = (prefix: string): string =>
    `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

const clearIdleTerminate = (): void => {
    if (idleTerminateTimer !== undefined) {
        clearTimeout(idleTerminateTimer);
        idleTerminateTimer = undefined;
    }
};

/**
 * Tear down the ffmpeg WASM instance to free its large linear memory.
 */
export const terminateFFmpeg = async (): Promise<void> => {
    clearIdleTerminate();
    const pending = ffmpegPromise;
    ffmpegPromise = undefined;
    if (!pending) {
        return;
    }
    try {
        const ffmpeg = await pending;
        ffmpeg.terminate();
    } catch {
        // Ignore terminate races.
    }
};

const scheduleIdleTerminate = (): void => {
    clearIdleTerminate();
    idleTerminateTimer = setTimeout(() => {
        void terminateFFmpeg();
    }, FFMPEG_IDLE_TERMINATE_MS);
};

const getFFmpeg = (): Promise<FFmpeg> => {
    clearIdleTerminate();
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
        logJsHeap("ffmpeg:before");
        const ffmpeg = await getFFmpeg();
        const mountDir = "/mount";
        const inputName = randomId("in_");
        const inputPath = `${mountDir}/${inputName}`;
        const outputPath = randomId("out_") + (outputExtension ? `.${outputExtension}` : "");
        const logs: string[] = [];
        const onLog = ({ message }: { message: string }): void => {
            if (message) {
                logs.push(message);
            }
        };

        try {
            ffmpeg.on("log", onLog);
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
                const detail = logs.slice(-8).join(" · ");
                throw new Error(
                    detail ?
                        `ffmpeg exited with code ${status}: ${detail}` :
                        `ffmpeg exited with code ${status}`,
                );
            }

            const result = await ffmpeg.readFile(outputPath);
            if (typeof result === "string") {
                throw new Error("Expected binary ffmpeg output");
            }
            // Copy out of MEMFS before teardown so terminate cannot invalidate it.
            const output = new Uint8Array(result);
            logJsHeap("ffmpeg:after");
            return output;
        } finally {
            ffmpeg.off("log", onLog);
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
            scheduleIdleTerminate();
        }
    }) as Promise<Uint8Array>;

/**
 * Extract a poster frame using the browser video decoder (reliable on mobile).
 * Draws at most {@link THUMB_FRAME_MAX_EDGE} on the long side to avoid full-res
 * RGBA canvases (4K frames are tens of MB).
 */
const extractVideoFrameViaCanvas = async (
    videoBytes: Uint8Array,
    mimeType: string,
): Promise<Uint8Array> => {
    const url = URL.createObjectURL(blobFromUint8Array(videoBytes, mimeType));
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
        const scale = Math.min(
            1,
            THUMB_FRAME_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight),
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Canvas unavailable");
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
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
    // Canvas path avoids loading ffmpeg WASM just for a poster frame.
    try {
        return await extractVideoFrameViaCanvas(videoBytes, mimeType);
    } catch {
        return await runFFmpeg(
            [
                "-i", "INPUT",
                "-frames:v", "1",
                "-vf", `scale='min(${THUMB_FRAME_MAX_EDGE},iw)':-2`,
                "-q:v", "4",
                "OUTPUT",
            ],
            blobFromUint8Array(videoBytes, mimeType),
            "jpg",
        );
    }
};
