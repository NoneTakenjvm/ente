import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type JSX,
    type RefObject,
} from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useVideoPlaybackStore } from "@/stores/video-playback-store";

interface VideoPlaybackControlsProps {
    videoRef: RefObject<HTMLVideoElement | null>;
    attachKey: string | undefined;
    visible: boolean;
    onScrubbingChange?: (scrubbing: boolean) => void;
}

const formatTime = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "0:00";
    }
    const total = Math.floor(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
};

export function VideoPlaybackControls({
    videoRef,
    attachKey,
    visible,
    onScrubbingChange,
}: VideoPlaybackControlsProps): JSX.Element | null {
    const hydrate = useVideoPlaybackStore((s) => s.hydrate);
    const muted = useVideoPlaybackStore((s) => s.muted);
    const toggleMuted = useVideoPlaybackStore((s) => s.toggleMuted);

    const [currentTime, setCurrentTime] = useState<number>(0);
    const [duration, setDuration] = useState<number>(0);
    const [playing, setPlaying] = useState<boolean>(false);
    const [scrubbing, setScrubbing] = useState<boolean>(false);
    const wasPlayingRef = useRef<boolean>(false);

    const setScrubbingState = useCallback(
        (next: boolean): void => {
            setScrubbing(next);
            onScrubbingChange?.(next);
        },
        [onScrubbingChange],
    );

    useEffect(() => {
        hydrate();
    }, [hydrate]);

    useEffect(() => {
        if (!scrubbing) {
            return;
        }
        const onPointerUp = (): void => {
            setScrubbingState(false);
            const video = videoRef.current;
            if (video && wasPlayingRef.current) {
                void video.play().catch(() => undefined);
            }
        };
        document.addEventListener("pointerup", onPointerUp);
        document.addEventListener("pointercancel", onPointerUp);
        return (): void => {
            document.removeEventListener("pointerup", onPointerUp);
            document.removeEventListener("pointercancel", onPointerUp);
        };
    }, [scrubbing, setScrubbingState, videoRef]);

    useEffect(() => {
        if (!attachKey || !visible) {
            return;
        }

        const video = videoRef.current;
        if (!video) {
            return;
        }

        const store = useVideoPlaybackStore.getState();
        video.volume = store.volume > 0 ? store.volume : 1;
        video.muted = store.muted;

        const syncDuration = (): void => {
            if (Number.isFinite(video.duration) && video.duration > 0) {
                setDuration(video.duration);
            }
        };
        const onTimeUpdate = (): void => {
            if (!scrubbing) {
                setCurrentTime(video.currentTime);
            }
        };
        const onPlay = (): void => setPlaying(true);
        const onPause = (): void => setPlaying(false);
        const onLoadedMetadata = (): void => {
            syncDuration();
            setCurrentTime(video.currentTime);
            setPlaying(!video.paused);
        };

        video.addEventListener("timeupdate", onTimeUpdate);
        video.addEventListener("durationchange", syncDuration);
        video.addEventListener("loadedmetadata", onLoadedMetadata);
        video.addEventListener("play", onPlay);
        video.addEventListener("pause", onPause);

        const frameId = requestAnimationFrame(() => {
            if (video.readyState >= 1) {
                onLoadedMetadata();
            }
        });

        return (): void => {
            cancelAnimationFrame(frameId);
            video.removeEventListener("timeupdate", onTimeUpdate);
            video.removeEventListener("durationchange", syncDuration);
            video.removeEventListener("loadedmetadata", onLoadedMetadata);
            video.removeEventListener("play", onPlay);
            video.removeEventListener("pause", onPause);
        };
    }, [attachKey, visible, videoRef, scrubbing]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) {
            return;
        }
        video.muted = muted;
        if (!muted && video.volume === 0) {
            video.volume = 1;
        }
    }, [muted, videoRef, attachKey]);

    const togglePlayPause = useCallback((): void => {
        const video = videoRef.current;
        if (!video) {
            return;
        }
        if (video.paused) {
            void video.play().catch(() => undefined);
        } else {
            video.pause();
        }
    }, [videoRef]);

    const seekToRatio = useCallback(
        (ratio: number): void => {
            const video = videoRef.current;
            if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
                return;
            }
            const nextTime = Math.min(
                video.duration,
                Math.max(0, ratio * video.duration),
            );
            video.currentTime = nextTime;
            setCurrentTime(nextTime);
        },
        [videoRef],
    );

    if (!visible) {
        return null;
    }

    const progress =
        duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

    return (
        <div
            className="flex shrink-0 items-center gap-2 border-b border-border/60 pb-2"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <span className="w-9 shrink-0 text-right text-[0.65rem] tabular-nums text-muted-foreground">
                {formatTime(currentTime)}
            </span>
            <Slider
                className="min-w-0 w-36 shrink"
                min={0}
                max={100}
                value={[progress]}
                disabled={duration <= 0}
                onPointerDown={() => {
                    setScrubbingState(true);
                    wasPlayingRef.current = playing;
                    const video = videoRef.current;
                    if (video && !video.paused) {
                        video.pause();
                    }
                }}
                onValueChange={(value) => {
                    const next = Array.isArray(value) ? value[0] : value;
                    if (next === undefined) {
                        return;
                    }
                    if (!scrubbing) {
                        wasPlayingRef.current = playing;
                        const video = videoRef.current;
                        if (video && !video.paused) {
                            video.pause();
                        }
                        setScrubbingState(true);
                    }
                    seekToRatio(next / 100);
                }}
            />
            <span className="w-9 shrink-0 text-[0.65rem] tabular-nums text-muted-foreground">
                {formatTime(duration)}
            </span>

            <div className="ml-auto flex shrink-0 items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label={playing ? "Pause" : "Play"}
                    onClick={togglePlayPause}
                >
                    {playing ? <Pause /> : <Play />}
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label={muted ? "Unmute" : "Mute"}
                    onClick={toggleMuted}
                >
                    {muted ? <VolumeX /> : <Volume2 />}
                </Button>
            </div>
        </div>
    );
}
