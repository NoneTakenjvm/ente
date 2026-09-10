import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { blobFromUint8Array } from "@/lib/bytes-blob";
import { MIN_VIDEO_CRF, MAX_VIDEO_CRF } from "@/lib/compress";

export interface WebCodecsH264Options {
    bytes: Uint8Array;
    mimeType: string;
    videoCrf: number;
    maxLongEdge?: number;
    onProgress?: (ratio: number) => void;
}

/** How audio was handled in the WebCodecs MP4. */
export type WebCodecsAudioOutcome =
    /** AAC was muxed into the MP4. */
    "aac" |
    /** Source had no audio track. */
    "none" |
    /** Source had audio but WebCodecs could not encode it — caller should remux. */
    "needs-remux";

export interface WebCodecsH264Result {
    bytes: Uint8Array;
    width: number;
    height: number;
    duration: number;
    audio: WebCodecsAudioOutcome;
}

const AVC_CODECS = ["avc1.640028", "avc1.4D401F", "avc1.42001E"] as const;
const DEFAULT_FPS = 30;
const KEYFRAME_INTERVAL_US = 2_000_000;
const AAC_BITRATE = 128_000;

type CaptureCapableVideo = HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
};

type TrackProcessor<T> = {
    readable: ReadableStream<T>;
};

type MediaStreamTrackProcessorCtor = new (init: {
    track: MediaStreamTrack;
}) => TrackProcessor<AudioData>;

/**
 * Even width/height for libx264-compatible output, optionally capped on the long edge.
 */
export const evenOutputSize = (
    width: number,
    height: number,
    maxLongEdge?: number,
): { width: number; height: number } => {
    let nextWidth = Math.max(0, width);
    let nextHeight = Math.max(0, height);
    if (maxLongEdge && maxLongEdge > 0 && Math.max(nextWidth, nextHeight) > maxLongEdge) {
        const scale = maxLongEdge / Math.max(nextWidth, nextHeight);
        nextWidth = Math.round(nextWidth * scale);
        nextHeight = Math.round(nextHeight * scale);
    }
    nextWidth -= nextWidth % 2;
    nextHeight -= nextHeight % 2;
    return {
        width: Math.max(2, nextWidth),
        height: Math.max(2, nextHeight),
    };
};

/**
 * Approximate H.264 bitrate for a CRF-like quality slider (18 = larger, 32 = smaller).
 */
export const bitrateForVideoCrf = (
    width: number,
    height: number,
    fps: number,
    crf: number,
): number => {
    const clamped = Math.min(MAX_VIDEO_CRF, Math.max(MIN_VIDEO_CRF, crf));
    const bitsPerPixel = 0.16 - ((clamped - MIN_VIDEO_CRF) / (MAX_VIDEO_CRF - MIN_VIDEO_CRF)) * 0.12;
    return Math.max(150_000, Math.round(width * height * fps * bitsPerPixel));
};

/**
 * Return true when this browser exposes {@link VideoEncoder}.
 */
export const isWebCodecsVideoEncoderAvailable = (): boolean =>
    typeof VideoEncoder !== "undefined";

const pickAvcCodec = async (
    width: number,
    height: number,
    fps: number,
    bitrate: number,
): Promise<string | undefined> => {
    if (!isWebCodecsVideoEncoderAvailable()) {
        return undefined;
    }
    for (const codec of AVC_CODECS) {
        try {
            const support = await VideoEncoder.isConfigSupported({
                codec,
                width,
                height,
                bitrate,
                framerate: fps,
                hardwareAcceleration: "prefer-hardware",
                avc: { format: "avc" },
            });
            if (support.supported) {
                return codec;
            }
        } catch {
            // try the next profile
        }
    }
    return undefined;
};

const waitForMetadata = (video: HTMLVideoElement): Promise<void> =>
    new Promise((resolve, reject) => {
        if (video.readyState >= 1 && video.videoWidth > 0) {
            resolve();
            return;
        }
        const fail = (): void => {
            cleanup();
            reject(new Error("Video decode failed"));
        };
        const ready = (): void => {
            cleanup();
            resolve();
        };
        const cleanup = (): void => {
            video.removeEventListener("loadedmetadata", ready);
            video.removeEventListener("error", fail);
        };
        video.addEventListener("loadedmetadata", ready);
        video.addEventListener("error", fail);
    });

const captureStreamFrom = (video: CaptureCapableVideo): MediaStream | undefined => {
    if (typeof video.captureStream === "function") {
        return video.captureStream();
    }
    if (typeof video.mozCaptureStream === "function") {
        return video.mozCaptureStream();
    }
    return undefined;
};

const audioProcessorCtor = (): MediaStreamTrackProcessorCtor | undefined =>
    (globalThis as unknown as {
        MediaStreamTrackProcessor?: MediaStreamTrackProcessorCtor;
    }).MediaStreamTrackProcessor;

/**
 * Re-encode video bytes as H.264/AAC MP4 using hardware WebCodecs when available.
 *
 * Video is always encoded when {@link VideoEncoder} works. Audio uses capture-stream
 * AAC when {@link MediaStreamTrackProcessor} is available; otherwise returns
 * {@code audio: "needs-remux"} so the caller can copy the original audio track
 * onto the hardware video (never silently drops audio).
 *
 * @throws when WebCodecs cannot encode video (caller should fall back to ffmpeg)
 */
export const encodeH264WebCodecs = async (
    options: WebCodecsH264Options,
): Promise<WebCodecsH264Result> => {
    if (!isWebCodecsVideoEncoderAvailable() || typeof document === "undefined") {
        throw new Error("WebCodecs VideoEncoder unavailable");
    }

    const blob = blobFromUint8Array(options.bytes, options.mimeType);
    const objectUrl = URL.createObjectURL(blob);
    const video = document.createElement("video") as CaptureCapableVideo;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("playsinline", "");
    video.style.cssText = "position:fixed;left:-9999px;width:2px;height:2px;opacity:0;";
    document.body.append(video);
    video.src = objectUrl;

    let encoder: VideoEncoder | undefined;
    let audioEncoder: AudioEncoder | undefined;
    let audioOutcome: WebCodecsAudioOutcome = "none";

    try {
        await waitForMetadata(video);
        const sourceWidth = video.videoWidth;
        const sourceHeight = video.videoHeight;
        if (sourceWidth <= 0 || sourceHeight <= 0) {
            throw new Error("Video frame dimensions unavailable");
        }
        const durationSec = Number.isFinite(video.duration) && video.duration > 0 ?
            video.duration :
            1;
        const { width, height } = evenOutputSize(
            sourceWidth,
            sourceHeight,
            options.maxLongEdge,
        );
        const bitrate = bitrateForVideoCrf(width, height, DEFAULT_FPS, options.videoCrf);
        const codec = await pickAvcCodec(width, height, DEFAULT_FPS, bitrate);
        if (!codec) {
            throw new Error("No supported H.264 encoder config");
        }

        await video.play();
        const stream = captureStreamFrom(video);
        const audioTrack = stream?.getAudioTracks()[0];
        const hasAudioTrack = Boolean(audioTrack);
        const Processor = audioProcessorCtor();
        const audioSettings = audioTrack?.getSettings() ?? {};
        const numberOfChannels = Math.max(1, audioSettings.channelCount ?? 2);
        const sampleRate = audioSettings.sampleRate ?? 44100;

        let canStreamEncodeAudio = false;
        if (
            hasAudioTrack &&
            typeof AudioEncoder !== "undefined" &&
            Processor !== undefined
        ) {
            try {
                const aacSupport = await AudioEncoder.isConfigSupported({
                    codec: "mp4a.40.2",
                    numberOfChannels,
                    sampleRate,
                    bitrate: AAC_BITRATE,
                });
                canStreamEncodeAudio = Boolean(aacSupport.supported);
            } catch {
                canStreamEncodeAudio = false;
            }
        }

        // Prefer streaming AAC when MediaStreamTrackProcessor exists. Otherwise
        // skip decodeAudioData (slow / often fails on video containers) and
        // remux original audio onto the hardware video afterward.
        const willMuxAac = canStreamEncodeAudio;
        if (hasAudioTrack && !willMuxAac) {
            audioOutcome = "needs-remux";
        }

        const target = new ArrayBufferTarget();
        const muxer = new Muxer({
            target,
            video: {
                codec: "avc",
                width,
                height,
                frameRate: DEFAULT_FPS,
            },
            audio: willMuxAac ?
                {
                    codec: "aac",
                    numberOfChannels,
                    sampleRate,
                } :
                undefined,
            fastStart: "in-memory",
            firstTimestampBehavior: "offset",
        });

        let encodeError: Error | undefined;
        const fail = (error: Error): void => {
            encodeError = error;
        };

        encoder = new VideoEncoder({
            output: (chunk, meta) => {
                muxer.addVideoChunk(chunk, meta);
            },
            error: (error) => {
                fail(error instanceof Error ? error : new Error(String(error)));
            },
        });
        encoder.configure({
            codec,
            width,
            height,
            bitrate,
            framerate: DEFAULT_FPS,
            hardwareAcceleration: "prefer-hardware",
            // realtime keeps the encode queue moving on mobile; quality mode
            // stalls behind our canvas/rVFC pump and feels much slower.
            latencyMode: "realtime",
            avc: { format: "avc" },
        });

        const needsScale = width !== sourceWidth || height !== sourceHeight;
        let scaleCanvas: OffscreenCanvas | undefined;
        let scaleContext: OffscreenCanvasRenderingContext2D | null = null;
        if (needsScale) {
            scaleCanvas = new OffscreenCanvas(width, height);
            scaleContext = scaleCanvas.getContext("2d", { alpha: false });
            if (!scaleContext) {
                throw new Error("OffscreenCanvas unavailable");
            }
        }

        if (canStreamEncodeAudio && audioTrack && Processor) {
            audioEncoder = new AudioEncoder({
                output: (chunk, meta) => {
                    muxer.addAudioChunk(chunk, meta);
                },
                error: (error) => {
                    fail(error instanceof Error ? error : new Error(String(error)));
                },
            });
            audioEncoder.configure({
                codec: "mp4a.40.2",
                numberOfChannels,
                sampleRate,
                bitrate: AAC_BITRATE,
            });
            const processor = new Processor({ track: audioTrack });
            const reader = processor.readable.getReader();
            void (async (): Promise<void> => {
                try {
                    while (!encodeError) {
                        const { value, done } = await reader.read();
                        if (done) {
                            break;
                        }
                        if (value) {
                            audioEncoder?.encode(value);
                            value.close();
                        }
                    }
                } catch (error: unknown) {
                    fail(error instanceof Error ? error : new Error("Audio encode failed"));
                }
            })();
            audioOutcome = "aac";
        }

        if (typeof video.requestVideoFrameCallback !== "function") {
            throw new Error("requestVideoFrameCallback unavailable");
        }

        let lastKeyUs = Number.NEGATIVE_INFINITY;
        await new Promise<void>((resolve, reject) => {
            const finish = (): void => {
                video.removeEventListener("ended", finish);
                resolve();
            };
            video.addEventListener("ended", finish);
            const onFrame = (
                _now: number,
                metadata: VideoFrameCallbackMetadata,
            ): void => {
                if (encodeError) {
                    video.removeEventListener("ended", finish);
                    reject(encodeError);
                    return;
                }
                const timestamp = Math.round(metadata.mediaTime * 1_000_000);
                try {
                    let frame: VideoFrame;
                    if (scaleCanvas && scaleContext) {
                        scaleContext.drawImage(video, 0, 0, width, height);
                        frame = new VideoFrame(scaleCanvas, {
                            timestamp,
                            alpha: "discard",
                        });
                    } else {
                        frame = new VideoFrame(video, { timestamp });
                    }
                    const keyFrame = timestamp - lastKeyUs >= KEYFRAME_INTERVAL_US;
                    if (keyFrame) {
                        lastKeyUs = timestamp;
                    }
                    encoder?.encode(frame, { keyFrame });
                    frame.close();
                    if (encoder && encoder.encodeQueueSize > 8) {
                        video.pause();
                        encoder.ondequeue = (): void => {
                            if (encoder && encoder.encodeQueueSize <= 2 && video.paused && !video.ended) {
                                void video.play();
                            }
                        };
                    }
                } catch (error: unknown) {
                    video.removeEventListener("ended", finish);
                    reject(error instanceof Error ? error : new Error("Video encode failed"));
                    return;
                }
                options.onProgress?.(Math.min(1, metadata.mediaTime / durationSec));
                if (!video.ended) {
                    video.requestVideoFrameCallback(onFrame);
                }
            };
            video.requestVideoFrameCallback(onFrame);
        });

        if (encodeError) {
            throw encodeError;
        }
        await encoder.flush();
        await audioEncoder?.flush();

        muxer.finalize();
        options.onProgress?.(1);
        if (!target.buffer) {
            throw new Error("MP4 mux produced no output");
        }
        return {
            bytes: new Uint8Array(target.buffer),
            width,
            height,
            duration: Math.max(1, Math.round(durationSec)),
            audio: hasAudioTrack ?
                audioOutcome === "aac" ? "aac" : "needs-remux" :
                "none",
        };
    } finally {
        try {
            encoder?.close();
        } catch {
            // already closed
        }
        try {
            audioEncoder?.close();
        } catch {
            // already closed
        }
        video.pause();
        for (const track of captureStreamFrom(video)?.getTracks() ?? []) {
            track.stop();
        }
        video.removeAttribute("src");
        video.load();
        video.remove();
        URL.revokeObjectURL(objectUrl);
    }
};
