import { useEffect, useRef, type RefObject } from "react";

interface SlideshowOptions {
    /** Whether the slideshow is on. */
    playing: boolean;
    /** Holds the timer (zoomed in, an editor or dialog open). */
    paused: boolean;
    /** Active slide's file id; the timer restarts on every new slide. */
    fileId: number | undefined;
    /** Active slide finished loading (or failed); nothing advances before. */
    mediaSettled: boolean;
    /** Active slide is a loaded video: advance when it ends, not on the timer. */
    advanceOnVideoEnd: boolean;
    seconds: number;
    activeVideoRef: RefObject<HTMLVideoElement | null>;
    /** Move to the next slide (the viewer loops back to the first). */
    advance: () => void;
}

/** Time left on a photo's timer when it was last held. */
interface HeldTimer {
    fileId: number | undefined;
    seconds: number;
    remainingMs: number;
}

/** A held photo timer never fires sooner than this after the hold lifts. */
const MIN_RESUME_MS = 1000;

/**
 * Advance the viewer on its own: photos after {@link SlideshowOptions.seconds},
 * videos when they end. A pause holds the photo timer; when it lifts the timer
 * resumes with its remaining time, but at least {@link MIN_RESUME_MS}. A video
 * that ended while paused advances as soon as the pause lifts. Keeps the
 * screen awake while playing.
 */
export function useSlideshow({
    playing,
    paused,
    fileId,
    mediaSettled,
    advanceOnVideoEnd,
    seconds,
    activeVideoRef,
    advance,
}: SlideshowOptions): void {
    const heldTimerRef = useRef<HeldTimer | undefined>(undefined);

    useEffect((): (() => void) | void => {
        if (!playing) {
            heldTimerRef.current = undefined;
            return;
        }
        if (paused || !mediaSettled) {
            return;
        }
        const video = activeVideoRef.current;
        if (advanceOnVideoEnd && video) {
            if (video.ended) {
                advance();
                return;
            }
            video.addEventListener("ended", advance);
            return (): void => {
                video.removeEventListener("ended", advance);
            };
        }
        const held = heldTimerRef.current;
        const delayMs =
            held && held.fileId === fileId && held.seconds === seconds ?
                Math.max(held.remainingMs, MIN_RESUME_MS) :
                seconds * 1000;
        const startedAt = Date.now();
        const timer = window.setTimeout(advance, delayMs);
        return (): void => {
            window.clearTimeout(timer);
            heldTimerRef.current = {
                fileId,
                seconds,
                remainingMs: delayMs - (Date.now() - startedAt),
            };
        };
    }, [
        activeVideoRef,
        advance,
        advanceOnVideoEnd,
        fileId,
        mediaSettled,
        paused,
        playing,
        seconds,
    ]);

    // Phones would otherwise dim and lock mid-slideshow.
    useEffect((): (() => void) | void => {
        if (!playing || !("wakeLock" in navigator)) {
            return;
        }
        let released = false;
        let sentinel: WakeLockSentinel | undefined;
        const acquire = (): void => {
            if (document.visibilityState !== "visible") {
                return;
            }
            navigator.wakeLock
                .request("screen")
                .then((lock) => {
                    if (released) {
                        void lock.release();
                        return;
                    }
                    sentinel = lock;
                })
                .catch(() => undefined);
        };
        acquire();
        // The browser drops the lock whenever the page is hidden.
        document.addEventListener("visibilitychange", acquire);
        return (): void => {
            released = true;
            document.removeEventListener("visibilitychange", acquire);
            void sentinel?.release();
        };
    }, [playing]);
}
