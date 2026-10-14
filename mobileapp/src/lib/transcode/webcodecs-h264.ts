import {
    ALL_FORMATS,
    BufferSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    Quality,
} from "mediabunny";
import { MIN_VIDEO_CRF, MAX_VIDEO_CRF } from "@/lib/compress";
import { evenOutputSize } from "@/lib/transcode/even-output-size";

export { evenOutputSize };

export interface WebCodecsH264Options {
    bytes: Uint8Array;
    videoCrf: number;
    maxLongEdge?: number;
    onProgress?: (ratio: number) => void;
    /** Aborting cancels the in-flight encode and rejects with the signal's reason. */
    signal?: AbortSignal;
}

export interface WebCodecsH264Result {
    bytes: Uint8Array;
    width: number;
    height: number;
    duration: number;
    /** True when the source audio was carried over (copied or re-encoded). */
    hasAudio: boolean;
}

/** Frame rate used for the bitrate budget, independent of the source rate. */
const BITRATE_FPS = 30;
const KEYFRAME_INTERVAL_SECONDS = 2;

let realtimeEncoderInstalled = false;

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

/**
 * Re-encode video bytes as an H.264 MP4 with WebCodecs, decoding the source as
 * fast as the hardware allows (not in realtime playback).
 *
 * Audio is copied when MP4 can hold it as-is, otherwise re-encoded. Rotation is
 * kept as container metadata.
 *
 * @throws when WebCodecs cannot convert the file, or when any audio/video track
 * would be dropped (caller should fall back to ffmpeg; never ships silent copies)
 */
export const encodeH264WebCodecs = async (
    options: WebCodecsH264Options,
): Promise<WebCodecsH264Result> => {
    if (!isWebCodecsVideoEncoderAvailable()) {
        throw new Error("WebCodecs VideoEncoder unavailable");
    }
    forceRealtimeEncoderOnWebKit();

    const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(options.bytes),
    });
    try {
        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) {
            throw new Error("No video track");
        }
        const { width, height } = evenOutputSize(
            await videoTrack.getDisplayWidth(),
            await videoTrack.getDisplayHeight(),
            options.maxLongEdge,
        );
        const target = new BufferTarget();
        const conversion = await Conversion.init({
            input,
            output: new Output({
                format: new Mp4OutputFormat({ fastStart: "in-memory" }),
                target,
            }),
            video: {
                codec: "avc",
                width,
                height,
                fit: "fill",
                quality: new Quality({
                    bitrate: bitrateForVideoCrf(width, height, BITRATE_FPS, options.videoCrf),
                }),
                keyFrameInterval: KEYFRAME_INTERVAL_SECONDS,
                forceTranscode: true,
            },
            showWarnings: false,
        });
        const droppedMedia = conversion.discardedTracks.filter(
            ({ track }) => track.type === "video" || track.type === "audio",
        );
        if (!conversion.isValid || droppedMedia.length > 0) {
            const reasons = droppedMedia
                .map(({ track, reason }) => `${track.type}: ${reason}`)
                .join(", ");
            throw new Error(`WebCodecs cannot convert video (${reasons || "invalid"})`);
        }

        conversion.onProgress = options.onProgress;
        const { signal } = options;
        signal?.throwIfAborted();
        // mediabunny checks for cancellation while it pumps samples, so an abort
        // stops the encode mid-stream instead of waiting for the next stage.
        const cancelOnAbort = (): void => {
            void conversion.cancel();
        };
        signal?.addEventListener("abort", cancelOnAbort, { once: true });
        try {
            await conversion.execute();
        } catch (error) {
            // A cancel surfaces as ConversionCanceledError; rethrow the abort reason.
            signal?.throwIfAborted();
            throw error;
        } finally {
            signal?.removeEventListener("abort", cancelOnAbort);
        }
        if (!target.buffer) {
            throw new Error("MP4 mux produced no output");
        }
        return {
            bytes: new Uint8Array(target.buffer),
            width,
            height,
            duration: Math.max(1, Math.round(await input.computeDuration())),
            hasAudio: conversion.utilizedTracks.some((track) => track.type === "audio"),
        };
    } finally {
        input.dispose();
    }
};

/**
 * [Note: Safari H.264 encoder hang]
 *
 * Safari 27.0.x hangs H.264 {@link VideoEncoder} jobs in the default "quality"
 * latency mode (WebKit bug 74602, mediabunny issue 541). Mediabunny's
 * Conversion cannot set the latency mode, so on WebKit we swap in a subclass
 * that always configures "realtime".
 */
const forceRealtimeEncoderOnWebKit = (): void => {
    const userAgent = navigator.userAgent;
    if (
        realtimeEncoderInstalled ||
        !/AppleWebKit/.test(userAgent) ||
        /Chrome\/|Chromium/.test(userAgent)
    ) {
        return;
    }
    realtimeEncoderInstalled = true;
    const NativeVideoEncoder = VideoEncoder;
    globalThis.VideoEncoder = class extends NativeVideoEncoder {
        override configure(config: VideoEncoderConfig): void {
            super.configure({ ...config, latencyMode: "realtime" });
        }
    };
};
