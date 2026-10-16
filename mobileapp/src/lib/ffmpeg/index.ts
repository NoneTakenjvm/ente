import { FFFSType, FFmpeg } from "@ffmpeg/ffmpeg";
import { PromiseQueue } from "ente-utils/promise";
import { blobFromUint8Array } from "@/lib/bytes-blob";
import { logJsHeap } from "@/lib/memory-probe";
import { withTimeout } from "@/lib/with-timeout";
import { createWorkerIdleTimer } from "@/lib/worker-idle-timer";

const CORE_BASE = "https://assets.ente.com/ffmpeg-core-0.12.10/";
/** SHA-256 of the single-thread UMD build, identical to npm `@ffmpeg/core@0.12.10`. */
const CORE_JS_SHA256 =
    "b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21";
const CORE_WASM_SHA256 =
    "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7";
/** Reclaim the WASM heap shortly after the last job (mobile Chrome). */
const FFMPEG_IDLE_TERMINATE_MS = 2_500;
const THUMB_FRAME_MAX_EDGE = 512;

let ffmpegPromise: Promise<FFmpeg> | undefined;
const taskQueue = new PromiseQueue<Uint8Array>();
const idleTimer = createWorkerIdleTimer(FFMPEG_IDLE_TERMINATE_MS, () => {
    void terminateFFmpeg();
});

export type FFmpegProgressCallback = (ratio: number) => void;

const randomId = (prefix: string): string =>
    `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

/**
 * Tear down the ffmpeg WASM instance to free its large linear memory.
 */
export const terminateFFmpeg = async (): Promise<void> => {
    idleTimer.clear();
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

/** Download a core file, check its SHA-256 and return a blob URL of the verified bytes. */
const fetchVerifiedCoreUrl = async (
    name: string,
    mimeType: string,
    expectedSha256: string,
): Promise<string> => {
    const response = await fetch(`${CORE_BASE}${name}`);
    if (!response.ok) {
        throw new Error(`ffmpeg core ${name} download failed (${response.status})`);
    }
    const bytes = await response.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const actualSha256 = Array.from(digest, (byte) =>
        byte.toString(16).padStart(2, "0")).join("");
    if (actualSha256 !== expectedSha256) {
        throw new Error(`ffmpeg core ${name} failed its integrity check`);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
};

const getFFmpeg = (): Promise<FFmpeg> => {
    idleTimer.clear();
    if (!ffmpegPromise) {
        const loading = (async (): Promise<FFmpeg> => {
            const [coreURL, wasmURL] = await Promise.all([
                fetchVerifiedCoreUrl(
                    "ffmpeg-core.js",
                    "text/javascript",
                    CORE_JS_SHA256,
                ),
                fetchVerifiedCoreUrl(
                    "ffmpeg-core.wasm",
                    "application/wasm",
                    CORE_WASM_SHA256,
                ),
            ]);
            try {
                const ffmpeg = new FFmpeg();
                await ffmpeg.load({ coreURL, wasmURL });
                return ffmpeg;
            } finally {
                URL.revokeObjectURL(coreURL);
                URL.revokeObjectURL(wasmURL);
            }
        })();
        ffmpegPromise = loading;
        // Drop a failed load so the next call retries instead of reusing it.
        loading.catch(() => {
            if (ffmpegPromise === loading) {
                ffmpegPromise = undefined;
            }
        });
    }
    return ffmpegPromise;
};

/**
 * Run an ffmpeg command on one or more blobs and return the output file bytes.
 *
 * Placeholders in {@link args}: `INPUT` / `INPUT0` for the first blob, `INPUT1`
 * … for further blobs, and `OUTPUT` for the write path.
 *
 * {@link onProgress} receives a 0–1 ratio when ffmpeg reports progress.
 */
export const runFFmpeg = async (
    args: string[],
    input: Blob | Blob[],
    outputExtension: string,
    onProgress?: FFmpegProgressCallback,
): Promise<Uint8Array> => {
    const inputs = Array.isArray(input) ? input : [input];
    if (inputs.length === 0) {
        throw new Error("ffmpeg requires at least one input");
    }
    return taskQueue.add(async (): Promise<Uint8Array> => {
        logJsHeap("ffmpeg:before");
        const ffmpeg = await getFFmpeg();
        const mountDir = "/mount";
        const inputFiles = inputs.map((blob, index) => {
            const name = randomId(`in${index}_`);
            return {
                file: new File([blob], name),
                path: `${mountDir}/${name}`,
            };
        });
        const outputPath = randomId("out_") + (outputExtension ? `.${outputExtension}` : "");
        const logs: string[] = [];
        const onLog = ({ message }: { message: string }): void => {
            if (message) {
                logs.push(message);
            }
        };
        const handleProgress = ({ progress }: { progress: number }): void => {
            if (!onProgress || !Number.isFinite(progress)) {
                return;
            }
            onProgress(Math.min(1, Math.max(0, progress)));
        };

        idleTimer.begin();
        try {
            ffmpeg.on("log", onLog);
            if (onProgress) {
                ffmpeg.on("progress", handleProgress);
            }
            await ffmpeg.createDir(mountDir);
            await ffmpeg.mount(
                FFFSType.WORKERFS,
                { files: inputFiles.map((entry) => entry.file) },
                mountDir,
            );

            const resolvedArgs = args.map((arg) => {
                if (arg === "INPUT" || arg === "INPUT0") {
                    return inputFiles[0]!.path;
                }
                const indexed = /^INPUT(\d+)$/u.exec(arg);
                if (indexed) {
                    const index = Number(indexed[1]);
                    const entry = inputFiles[index];
                    if (!entry) {
                        throw new Error(`ffmpeg missing input ${index}`);
                    }
                    return entry.path;
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
            onProgress?.(1);
            // Copy out of MEMFS before teardown so terminate cannot invalidate it.
            const output = new Uint8Array(result);
            logJsHeap("ffmpeg:after");
            return output;
        } finally {
            ffmpeg.off("log", onLog);
            if (onProgress) {
                ffmpeg.off("progress", handleProgress);
            }
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
            idleTimer.end();
        }
    }) as Promise<Uint8Array>;
};

/** Resolve when {@link video} fires the `ready` handler; reject on error or after 20s. */
const waitForVideoEvent = (
    video: HTMLVideoElement,
    ready: "onloadedmetadata" | "onseeked" | "onloadeddata",
    errorMessage: string,
    timeoutMessage: string,
): Promise<void> =>
    withTimeout(
        new Promise<void>((resolve, reject) => {
            video[ready] = () => resolve();
            video.onerror = () => reject(new Error(errorMessage));
        }),
        20_000,
        timeoutMessage,
    );

/**
 * Extract a poster frame using the browser video decoder (reliable on mobile).
 * Draws at most {@link THUMB_FRAME_MAX_EDGE} on the long side to avoid full-res
 * RGBA canvases (4K frames are tens of MB).
 */
const extractVideoFrameViaCanvas = async (
    source: Blob,
): Promise<Uint8Array> => {
    const url = URL.createObjectURL(source);
    try {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        // "metadata" leaves some browsers with no decoded frame to draw.
        video.preload = "auto";
        video.src = url;
        await waitForVideoEvent(
            video,
            "onloadedmetadata",
            "Video frame decode failed",
            "Timed out decoding video frame",
        );
        if (video.videoWidth <= 0 || video.videoHeight <= 0) {
            throw new Error("Video frame dimensions unavailable");
        }
        const seekTime =
            Number.isFinite(video.duration) && video.duration > 0 ?
                Math.min(0.1, video.duration / 2) :
                0;
        if (seekTime > 0) {
            video.currentTime = seekTime;
            await waitForVideoEvent(
                video,
                "onseeked",
                "Video seek failed",
                "Timed out seeking video frame",
            );
        }
        // Drawing before a frame is decoded yields a blank canvas, not an error.
        if (video.readyState < 2) {
            await waitForVideoEvent(
                video,
                "onloadeddata",
                "Video frame decode failed",
                "Timed out decoding video frame",
            );
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
        // An all-black frame means the decoder gave us nothing; let the caller
        // fall back to ffmpeg.
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        let hasContent = false;
        for (let i = 0; i < data.length; i += 4 * 17) {
            if (data[i]! > 8 || data[i + 1]! > 8 || data[i + 2]! > 8) {
                hasContent = true;
                break;
            }
        }
        if (!hasContent) {
            throw new Error("Video frame is blank");
        }
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
 * Extract a single JPEG frame from a video (bytes or a picked file) for
 * thumbnails.
 */
export const extractVideoFrameJpeg = async (
    video: Uint8Array | Blob,
    mimeType: string,
): Promise<Uint8Array> => {
    // A picked File stays on disk; only in-memory bytes need wrapping.
    const videoBlob =
        video instanceof Blob ? video : blobFromUint8Array(video, mimeType);
    // Canvas path avoids loading ffmpeg WASM just for a poster frame.
    try {
        return await extractVideoFrameViaCanvas(videoBlob);
    } catch {
        return await runFFmpeg(
            [
                "-i", "INPUT",
                "-frames:v", "1",
                "-vf", `scale='min(${THUMB_FRAME_MAX_EDGE},iw)':-2`,
                "-q:v", "4",
                "OUTPUT",
            ],
            videoBlob,
            "jpg",
        );
    }
};
