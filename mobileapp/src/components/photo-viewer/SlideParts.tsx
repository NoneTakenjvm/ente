import {
    useCallback,
    useEffect,
    useRef,
    type ComponentProps,
    type JSX,
    type ReactNode,
    type RefObject,
} from "react";
import { Progress } from "@/components/ui/progress";
import { useThumbnailEntry } from "@/hooks/use-thumbnail-entry";
import { formatFileSize } from "@/lib/format";
import type { EnteFile } from "ente-media/file";
import type { SlideMedia } from "@/hooks/use-slide-media";

/**
 * Label + optional size/progress for full-media download in the viewer.
 */
export function MediaDownloadIndicator({
    kind,
    media,
}: {
    kind: "video" | "photo";
    media?: SlideMedia;
}): JSX.Element {
    const { progress, bytesLoaded, bytesTotal } = media ?? {};
    const label =
        kind === "video" ? "Downloading video..." : "Downloading photo...";
    const sizeLabel =
        bytesLoaded !== undefined &&
        bytesTotal !== undefined &&
        bytesTotal > 0 ?
            `${formatFileSize(bytesLoaded)} / ${formatFileSize(bytesTotal)}` :
            bytesLoaded !== undefined && bytesLoaded > 0 ?
                formatFileSize(bytesLoaded) :
                undefined;

    return (
        <div
            className="flex w-52 flex-col items-center gap-1.5"
            role="status"
            aria-label={label}
        >
            <span className="text-center text-xs text-muted-foreground">
                {label}
            </span>
            {sizeLabel ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                    {sizeLabel}
                </span>
            ) : null}
            {progress !== undefined ? (
                <Progress value={progress} className="w-full" />
            ) : (
                <div
                    className="h-1.5 w-full animate-pulse rounded-full bg-primary/50"
                    aria-hidden
                />
            )}
        </div>
    );
}

/**
 * Show the cached gallery thumbnail while a video slide decrypts/downloads.
 */
export function VideoSlidePoster({
    file,
    children,
}: {
    file: EnteFile;
    children?: ReactNode;
}): JSX.Element {
    const thumb = useThumbnailEntry(file);

    return (
        <div className="absolute inset-0 bg-black/40">
            {thumb.status === "ready" && thumb.url ? (
                <img
                    className="pointer-events-none size-full object-contain select-none"
                    src={thumb.url}
                    alt=""
                    draggable={false}
                />
            ) : null}
            {children ? (
                <div className="absolute inset-0 flex items-center justify-center">
                    {children}
                </div>
            ) : null}
        </div>
    );
}

/**
 * Slide `<video>` that releases its decoder buffers when it unmounts.
 *
 * @param activeVideoRef set only on the visible slide; tracks its element.
 */
export function SlideVideo({
    activeVideoRef,
    ...videoProps
}: ComponentProps<"video"> & {
    activeVideoRef?: RefObject<HTMLVideoElement | null>;
}): JSX.Element {
    const elementRef = useRef<HTMLVideoElement | null>(null);
    const setElement = useCallback(
        (video: HTMLVideoElement | null): void => {
            elementRef.current = video;
            if (activeVideoRef) {
                activeVideoRef.current = video;
            }
        },
        [activeVideoRef],
    );

    useEffect((): (() => void) => {
        const video = elementRef.current;
        return (): void => {
            // Still connected means a dev-mode effect replay, not a real unmount.
            if (video && !video.isConnected) {
                releaseVideoElement(video);
            }
        };
    }, []);

    return <video ref={setElement} {...videoProps} />;
}

/**
 * Decode and pause on the first frame so the preview is not black when autoplay is off.
 */
export const primeVideoFirstFrame = (video: HTMLVideoElement): void => {
    const seekToStart = (): void => {
        video.pause();
        try {
            video.currentTime = 0;
        } catch {
            // Metadata may not be ready yet on some browsers.
        }
    };

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        seekToStart();
        return;
    }

    video.addEventListener("loadeddata", seekToStart, { once: true });

    void video.play()
        .then(() => {
            video.pause();
            seekToStart();
        })
        .catch(() => {
            seekToStart();
        });
};

/**
 * Detach a video's source so Safari frees its decoder buffers.
 */
const releaseVideoElement = (video: HTMLVideoElement): void => {
    video.pause();
    video.removeAttribute("src");
    video.load();
};
