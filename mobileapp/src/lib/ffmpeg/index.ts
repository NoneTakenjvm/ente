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
 * Extract a single JPEG frame from video bytes for thumbnails.
 */
export const extractVideoFrameJpeg = async (
    videoBytes: Uint8Array,
    mimeType: string,
): Promise<Uint8Array> =>
    runFFmpeg(
        ["-i", "INPUT", "-frames:v", "1", "-q:v", "2", "OUTPUT"],
        new Blob([Uint8Array.from(videoBytes)], { type: mimeType }),
        "jpg",
    );
