import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
} from "react";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { usePinchZoom } from "@/hooks/use-pinch-zoom";

type CarouselDragMode = "horizontal" | "dismiss";

interface CarouselDragStart {
    x: number;
    y: number;
    dragPx: number;
    dragging: boolean;
    mode?: CarouselDragMode;
}

type ActiveMedia = HTMLImageElement | HTMLVideoElement;

interface ViewerGesturesOptions {
    /** Active slide's file id; zoom and drag reset when it changes. */
    fileId: number | undefined;
    fileCount: number;
    currentIndex: number;
    setCurrentIndex: (index: number) => void;
    zoomEnabled: boolean;
    cropMode: boolean;
    /** Keeps the chrome visible (dialogs, sheets, scrubbing). */
    chromePaused: boolean;
    /** Ignore keyboard shortcuts while a dialog, sheet or editor is open. */
    keysBlocked: boolean;
    onClose: () => void;
    viewportRef: RefObject<HTMLDivElement | null>;
    activeImageRef: RefObject<HTMLImageElement | null>;
    activeVideoRef: RefObject<HTMLVideoElement | null>;
}

export interface ViewerGestures {
    viewportWidth: number;
    trackStyle: CSSProperties;
    viewportHandlers: {
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
        onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
        onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
        onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
    };
    /** Props for the active slide's zoom surface. */
    zoomProps: {
        style: CSSProperties;
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
        onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
        onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
        onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
        ref: (element: HTMLElement | null) => (() => void) | undefined;
    };
    /** Point the zoom hook at the active slide's loaded media element. */
    registerActiveMedia: (media: ActiveMedia | null) => void;
    goPrev: () => void;
    goNext: () => void;
    carouselAnimating: boolean;
    chromeVisible: boolean;
    resetChromeTimer: () => void;
    resetZoom: () => void;
    clearPointers: () => void;
}

const CAROUSEL_TRANSITION_MS = 280;
const SWIPE_THRESHOLD_RATIO = 0.22;
const SWIPE_THRESHOLD_MIN_PX = 40;
const CAROUSEL_DRAG_DEAD_ZONE_PX = 8;
const CHROME_HIDE_MS = 2000;
const TAP_MAX_MOVEMENT_PX = 10;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_MAX_DISTANCE_PX = 24;
const DISMISS_THRESHOLD_MIN_PX = 80;
const DISMISS_THRESHOLD_RATIO = 0.15;

const isTextEntryTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);

/**
 * Pointer and keyboard input for the viewer: swipe carousel, drag-to-dismiss,
 * pinch/double-tap zoom, tap-to-toggle chrome and the chrome auto-hide timer.
 *
 * Taps are recognised in one place: a single pointer that goes down and up
 * without moving. Two taps close together make a double tap (zoom).
 */
export function useViewerGestures({
    fileId,
    fileCount,
    currentIndex,
    setCurrentIndex,
    zoomEnabled,
    cropMode,
    chromePaused,
    keysBlocked,
    onClose,
    viewportRef,
    activeImageRef,
    activeVideoRef,
}: ViewerGesturesOptions): ViewerGestures {
    const [carouselDragPx, setCarouselDragPx] = useState<number>(0);
    const [dismissDragPx, setDismissDragPx] = useState<number>(0);
    const [carouselAnimating, setCarouselAnimating] = useState<boolean>(false);
    const [viewportWidth, setViewportWidth] = useState<number>(0);
    const [viewportHeight, setViewportHeight] = useState<number>(0);
    const [chromeVisible, setChromeVisible] = useState<boolean>(true);
    const coarsePointer = useCoarsePointer();

    const pinchLayoutRef = useRef<
        { container: HTMLElement; image: ActiveMedia } | null
    >(null);
    const carouselDragStartRef = useRef<CarouselDragStart | undefined>(undefined);
    const carouselPointerIdRef = useRef<number | undefined>(undefined);
    const chromeTimerRef = useRef<number | undefined>(undefined);
    /** Pending slide change after a swipe animation; cleared on re-entry and unmount. */
    const carouselTransitionTimerRef = useRef<number | undefined>(undefined);
    const activePointerIdsRef = useRef<Set<number>>(new Set());
    const tapCandidateRef = useRef<
        { pointerId: number; x: number; y: number; valid: boolean } | undefined
    >(undefined);
    const lastTapRef = useRef<
        { time: number; x: number; y: number } | undefined
    >(undefined);
    const fileCountRef = useRef<number>(fileCount);

    useEffect((): void => {
        fileCountRef.current = fileCount;
    }, [fileCount]);

    useEffect((): (() => void) => {
        return (): void => {
            window.clearTimeout(carouselTransitionTimerRef.current);
        };
    }, []);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) {
            return;
        }
        const updateSize = (): void => {
            setViewportWidth(viewport.clientWidth);
            setViewportHeight(viewport.clientHeight);
        };
        updateSize();
        const observer = new ResizeObserver(updateSize);
        observer.observe(viewport);
        return (): void => {
            observer.disconnect();
        };
    }, [viewportRef]);

    // Zoomed pan must not advance the carousel — edge overflow stays in-image only.
    const pinchZoom = usePinchZoom({
        enabled: zoomEnabled,
        layoutRef: pinchLayoutRef,
    });

    const {
        reset: resetZoom,
        updatePanBounds,
        scale: zoomScale,
        getPointerCount,
        registerPointer,
        clearPointers,
        releasePointer,
    } = pinchZoom;

    // Drop any in-progress drag when the active slide changes.
    const [draggedFileId, setDraggedFileId] = useState<number | undefined>(
        fileId,
    );
    if (draggedFileId !== fileId) {
        setDraggedFileId(fileId);
        setCarouselDragPx(0);
        setDismissDragPx(0);
    }

    useEffect((): void => {
        resetZoom();
    }, [fileId, resetZoom]);

    useEffect((): void => {
        const viewport = viewportRef.current;
        const media = activeImageRef.current ?? activeVideoRef.current;
        if (!viewport || !media || zoomScale <= 1.01) {
            return;
        }
        updatePanBounds(viewport, media);
        pinchLayoutRef.current = { container: viewport, image: media };
    }, [
        activeImageRef,
        activeVideoRef,
        viewportRef,
        updatePanBounds,
        zoomScale,
        fileId,
        viewportWidth,
    ]);

    const registerActiveMedia = useCallback(
        (media: ActiveMedia | null): void => {
            if (viewportRef.current && media) {
                pinchLayoutRef.current = {
                    container: viewportRef.current,
                    image: media,
                };
                updatePanBounds(viewportRef.current, media);
            }
        },
        [updatePanBounds, viewportRef],
    );

    // Chrome auto-hide.

    const handleMediaTap = useCallback((): void => {
        window.clearTimeout(chromeTimerRef.current);
        if (chromeVisible) {
            setChromeVisible(false);
            return;
        }
        setChromeVisible(true);
        if (chromePaused) {
            return;
        }
        chromeTimerRef.current = window.setTimeout((): void => {
            setChromeVisible(false);
        }, CHROME_HIDE_MS);
    }, [chromePaused, chromeVisible]);

    const resetChromeTimer = useCallback((): void => {
        window.clearTimeout(chromeTimerRef.current);
        if (chromePaused || !chromeVisible) {
            return;
        }
        chromeTimerRef.current = window.setTimeout((): void => {
            setChromeVisible(false);
        }, CHROME_HIDE_MS);
    }, [chromePaused, chromeVisible]);

    useEffect((): (() => void) => {
        if (chromePaused) {
            window.clearTimeout(chromeTimerRef.current);
            return (): void => undefined;
        }
        if (chromeVisible) {
            resetChromeTimer();
        }
        return (): void => {
            window.clearTimeout(chromeTimerRef.current);
        };
    }, [chromePaused, chromeVisible, resetChromeTimer]);

    // Desktop: hide chrome only after the pointer has been still for CHROME_HIDE_MS.
    useEffect((): (() => void) => {
        if (coarsePointer || chromePaused || !chromeVisible) {
            return (): void => undefined;
        }
        const onPointerMove = (event: PointerEvent): void => {
            if (event.pointerType === "touch") {
                return;
            }
            resetChromeTimer();
        };
        document.addEventListener("pointermove", onPointerMove);
        return (): void => {
            document.removeEventListener("pointermove", onPointerMove);
        };
    }, [chromePaused, chromeVisible, coarsePointer, resetChromeTimer]);

    // Carousel.

    const goToIndex = useCallback(
        (index: number, animate = false): void => {
            window.clearTimeout(carouselTransitionTimerRef.current);
            if (index < 0 || index >= fileCount || index === currentIndex) {
                setCarouselDragPx(0);
                setCarouselAnimating(false);
                return;
            }
            if (animate && viewportWidth > 0) {
                const goingNext = index > currentIndex;
                setCarouselAnimating(true);
                setCarouselDragPx(goingNext ? -viewportWidth : viewportWidth);
                carouselTransitionTimerRef.current = window.setTimeout(() => {
                    // Files can shrink while the slide animates (delete / trash).
                    const lastIndex = fileCountRef.current - 1;
                    setCurrentIndex(Math.max(0, Math.min(index, lastIndex)));
                    setCarouselDragPx(0);
                    setCarouselAnimating(false);
                    resetZoom();
                }, CAROUSEL_TRANSITION_MS);
                return;
            }
            setCurrentIndex(index);
            setCarouselDragPx(0);
            setCarouselAnimating(false);
            resetZoom();
        },
        [currentIndex, fileCount, resetZoom, setCurrentIndex, viewportWidth],
    );

    const goPrev = useCallback((): void => {
        goToIndex(currentIndex - 1, true);
    }, [currentIndex, goToIndex]);

    const goNext = useCallback((): void => {
        goToIndex(currentIndex + 1, true);
    }, [currentIndex, goToIndex]);

    const cancelCarouselDrag = useCallback((): void => {
        const carouselPointerId = carouselPointerIdRef.current;
        carouselPointerIdRef.current = undefined;
        carouselDragStartRef.current = undefined;
        setCarouselDragPx(0);
        setDismissDragPx(0);
        if (carouselPointerId !== undefined && viewportRef.current) {
            try {
                viewportRef.current.releasePointerCapture(carouselPointerId);
            } catch {
                // Pointer may already be released.
            }
        }
    }, [viewportRef]);

    const finishCarouselDrag = useCallback((mode?: CarouselDragMode): void => {
        if (mode === "dismiss") {
            const threshold = Math.max(
                DISMISS_THRESHOLD_MIN_PX,
                viewportHeight * DISMISS_THRESHOLD_RATIO,
            );
            if (dismissDragPx > threshold) {
                onClose();
                return;
            }
            setCarouselAnimating(true);
            setDismissDragPx(0);
            window.setTimeout(() => {
                setCarouselAnimating(false);
            }, CAROUSEL_TRANSITION_MS);
            return;
        }

        const threshold = Math.max(
            SWIPE_THRESHOLD_MIN_PX,
            viewportWidth * SWIPE_THRESHOLD_RATIO,
        );
        if (carouselDragPx > threshold && currentIndex > 0) {
            goToIndex(currentIndex - 1, true);
            return;
        }
        if (carouselDragPx < -threshold && currentIndex < fileCount - 1) {
            goToIndex(currentIndex + 1, true);
            return;
        }
        setCarouselAnimating(true);
        setCarouselDragPx(0);
        window.setTimeout(() => {
            setCarouselAnimating(false);
        }, CAROUSEL_TRANSITION_MS);
    }, [
        carouselDragPx,
        currentIndex,
        dismissDragPx,
        fileCount,
        goToIndex,
        onClose,
        viewportHeight,
        viewportWidth,
    ]);

    // Taps.

    const startTapCandidate = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        const pointerIds = activePointerIdsRef.current;
        // A mouse is one pointer; drop ids left behind by a release outside the viewport.
        if (event.pointerType === "mouse") {
            pointerIds.clear();
        }
        pointerIds.add(event.pointerId);
        if (pointerIds.size > 1) {
            if (tapCandidateRef.current) {
                tapCandidateRef.current.valid = false;
            }
            return;
        }
        if (event.pointerType === "mouse" && event.button !== 0) {
            return;
        }
        tapCandidateRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            valid: true,
        };
    };

    /** Forget the pointer; true when it completed a tap. */
    const endTapCandidate = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): boolean => {
        activePointerIdsRef.current.delete(event.pointerId);
        const candidate = tapCandidateRef.current;
        if (candidate?.pointerId !== event.pointerId) {
            return false;
        }
        tapCandidateRef.current = undefined;
        return (
            candidate.valid &&
            event.type === "pointerup" &&
            Math.hypot(
                event.clientX - candidate.x,
                event.clientY - candidate.y,
            ) < TAP_MAX_MOVEMENT_PX
        );
    };

    const handleTap = (clientX: number, clientY: number): void => {
        handleMediaTap();
        const now = Date.now();
        const last = lastTapRef.current;
        if (
            last &&
            now - last.time < DOUBLE_TAP_MS &&
            Math.hypot(clientX - last.x, clientY - last.y) <
                DOUBLE_TAP_MAX_DISTANCE_PX
        ) {
            lastTapRef.current = undefined;
            const container = viewportRef.current;
            if (container && zoomEnabled) {
                pinchZoom.onDoubleTap(clientX, clientY, container);
            }
            return;
        }
        lastTapRef.current = { time: now, x: clientX, y: clientY };
    };

    // Pointer handlers.

    const handleViewportPointerDown = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        startTapCandidate(event);
        if (
            cropMode ||
            carouselAnimating ||
            zoomScale > 1.01 ||
            event.pointerType === "mouse" && event.button !== 0
        ) {
            return;
        }
        if (
            carouselPointerIdRef.current !== undefined &&
            carouselPointerIdRef.current !== event.pointerId
        ) {
            cancelCarouselDrag();
            return;
        }
        carouselPointerIdRef.current = event.pointerId;
        carouselDragStartRef.current = {
            x: event.clientX,
            y: event.clientY,
            dragPx: carouselDragPx,
            dragging: false,
        };
    };

    const handleViewportPointerMove = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        if (getPointerCount() >= 2) {
            cancelCarouselDrag();
            return;
        }
        if (
            carouselPointerIdRef.current !== event.pointerId ||
            !carouselDragStartRef.current
        ) {
            return;
        }
        const deltaX = event.clientX - carouselDragStartRef.current.x;
        const deltaY = event.clientY - carouselDragStartRef.current.y;
        if (!carouselDragStartRef.current.dragging) {
            if (
                deltaY > CAROUSEL_DRAG_DEAD_ZONE_PX &&
                deltaY > Math.abs(deltaX)
            ) {
                carouselDragStartRef.current.dragging = true;
                carouselDragStartRef.current.mode = "dismiss";
            } else if (
                Math.abs(deltaX) > CAROUSEL_DRAG_DEAD_ZONE_PX &&
                Math.abs(deltaX) > Math.abs(deltaY)
            ) {
                carouselDragStartRef.current.dragging = true;
                carouselDragStartRef.current.mode = "horizontal";
            } else {
                return;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
        }
        if (carouselDragStartRef.current.mode === "dismiss") {
            setDismissDragPx(Math.max(0, deltaY));
            return;
        }
        let nextDrag = carouselDragStartRef.current.dragPx + deltaX;
        if (currentIndex === 0 && nextDrag > 0) {
            nextDrag *= 0.35;
        }
        if (currentIndex >= fileCount - 1 && nextDrag < 0) {
            nextDrag *= 0.35;
        }
        setCarouselDragPx(nextDrag);
    };

    const handleViewportPointerUp = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        const wasDragging = carouselDragStartRef.current?.dragging === true;
        if (endTapCandidate(event) && !wasDragging) {
            handleTap(event.clientX, event.clientY);
        }
        if (carouselPointerIdRef.current !== event.pointerId) {
            return;
        }
        releasePointer(event.pointerId);
        const start = carouselDragStartRef.current;
        carouselPointerIdRef.current = undefined;
        carouselDragStartRef.current = undefined;
        if (start?.dragging) {
            finishCarouselDrag(start.mode);
        }
    };

    /** A cancelled touch is not a tap: only drop the pointer and drag state. */
    const handleViewportPointerCancel = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        endTapCandidate(event);
        if (carouselPointerIdRef.current !== event.pointerId) {
            return;
        }
        releasePointer(event.pointerId);
        cancelCarouselDrag();
    };

    const handleZoomPointerDown = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        const pointerCountBefore = getPointerCount();
        pinchZoom.onPointerDown(event);
        // While zoomed the zoom layer stops propagation, so the viewport never sees this pointer.
        if (event.isPropagationStopped()) {
            startTapCandidate(event);
        }
        if (getPointerCount() >= 2 && pointerCountBefore < 2) {
            if (pointerCountBefore === 0) {
                // Feed the carousel's first finger into the pinch.
                const carouselPointerId = carouselPointerIdRef.current;
                const carouselStart = carouselDragStartRef.current;
                if (
                    carouselPointerId !== undefined &&
                    carouselStart &&
                    carouselPointerId !== event.pointerId
                ) {
                    registerPointer(
                        carouselPointerId,
                        carouselStart.x,
                        carouselStart.y,
                    );
                }
            }
            cancelCarouselDrag();
            event.currentTarget.setPointerCapture(event.pointerId);
        }
    };

    const handleZoomPointerUp = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        pinchZoom.onPointerUp(event);
        // Zoomed: the viewport won't see this pointer up, so detect the tap here.
        if (event.isPropagationStopped() && endTapCandidate(event)) {
            handleTap(event.clientX, event.clientY);
        }
    };

    // Keyboard.

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            // Open sheets/dialogs, the crop/video editor (which guards Escape
            // while saving) and text fields own their keys: an arrow in the tag
            // search must not change slides mid-draft.
            if (
                event.defaultPrevented ||
                keysBlocked ||
                isTextEntryTarget(event.target)
            ) {
                return;
            }
            resetChromeTimer();
            if (event.key === "Escape") {
                if (zoomScale > 1.01 && zoomEnabled) {
                    resetZoom();
                    return;
                }
                onClose();
            } else if (event.key === "ArrowLeft") {
                goPrev();
            } else if (event.key === "ArrowRight") {
                goNext();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return (): void => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [
        goNext,
        goPrev,
        keysBlocked,
        onClose,
        resetChromeTimer,
        resetZoom,
        zoomEnabled,
        zoomScale,
    ]);

    const trackTranslatePx =
        viewportWidth > 0 ?
            -viewportWidth + carouselDragPx :
            carouselDragPx;
    const dismissOpacity =
        viewportHeight > 0 ?
            Math.max(0.35, 1 - dismissDragPx / viewportHeight) :
            1;

    return {
        viewportWidth,
        trackStyle: {
            transform: `translate3d(${trackTranslatePx}px, ${dismissDragPx}px, 0)`,
            opacity: dismissDragPx > 0 ? dismissOpacity : 1,
            transition:
                carouselAnimating ?
                    `transform ${CAROUSEL_TRANSITION_MS}ms ease-out, opacity ${CAROUSEL_TRANSITION_MS}ms ease-out` :
                    undefined,
        },
        viewportHandlers: {
            onPointerDown: handleViewportPointerDown,
            onPointerMove: handleViewportPointerMove,
            onPointerUp: handleViewportPointerUp,
            onPointerCancel: handleViewportPointerCancel,
        },
        zoomProps: {
            style: pinchZoom.transformStyle,
            onPointerDown: handleZoomPointerDown,
            onPointerMove: pinchZoom.onPointerMove,
            onPointerUp: handleZoomPointerUp,
            onPointerCancel: handleZoomPointerUp,
            ref: pinchZoom.wheelTargetRef,
        },
        registerActiveMedia,
        goPrev,
        goNext,
        carouselAnimating,
        chromeVisible,
        resetChromeTimer,
        resetZoom,
        clearPointers,
    };
}
