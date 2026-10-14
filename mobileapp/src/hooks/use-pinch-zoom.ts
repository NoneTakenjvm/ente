import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 3;
const ZOOM_TRANSITION_MS = 250;

interface PanBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

interface PinchLayout {
    container: HTMLElement;
    image: HTMLImageElement | HTMLVideoElement;
}

interface PinchZoomOptions {
    enabled: boolean;
    layoutRef?: { current: PinchLayout | null };
}

interface PinchZoomState {
    scale: number;
    translateX: number;
    translateY: number;
    transitionEnabled: boolean;
    getPointerCount: () => number;
    onDoubleTap: (clientX: number, clientY: number, container: HTMLElement) => void;
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    wheelTargetRef: (element: HTMLElement | null) => (() => void) | undefined;
    registerPointer: (pointerId: number, x: number, y: number) => void;
    clearPointers: () => void;
    releasePointer: (pointerId: number) => void;
    reset: () => void;
    updatePanBounds: (
        container: HTMLElement,
        image: HTMLImageElement | HTMLVideoElement,
    ) => void;
    transformStyle: { transform: string; transition?: string };
}

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

/**
 * Size of an image as rendered with `object-fit: contain` inside a container.
 */
const getObjectContainSize = (
    media: HTMLImageElement | HTMLVideoElement,
    containerWidth: number,
    containerHeight: number,
): { width: number; height: number } => {
    const naturalWidth =
        media instanceof HTMLVideoElement ?
            media.videoWidth :
            media.naturalWidth;
    const naturalHeight =
        media instanceof HTMLVideoElement ?
            media.videoHeight :
            media.naturalHeight;
    if (
        naturalWidth <= 0 ||
        naturalHeight <= 0 ||
        containerWidth <= 0 ||
        containerHeight <= 0
    ) {
        return {
            width: media.clientWidth,
            height: media.clientHeight,
        };
    }
    const fitScale = Math.min(
        containerWidth / naturalWidth,
        containerHeight / naturalHeight,
    );
    return {
        width: naturalWidth * fitScale,
        height: naturalHeight * fitScale,
    };
};

const computePanBounds = (
    containerWidth: number,
    containerHeight: number,
    imageWidth: number,
    imageHeight: number,
    scale: number,
): PanBounds => {
    const scaledWidth = imageWidth * scale;
    const scaledHeight = imageHeight * scale;
    const maxX = Math.max(0, (scaledWidth - containerWidth) / 2);
    const maxY = Math.max(0, (scaledHeight - containerHeight) / 2);
    return {
        minX: -maxX,
        maxX,
        minY: -maxY,
        maxY,
    };
};

const pinchDistance = (
    pointers: Map<number, { x: number; y: number }>,
): number => {
    const points = [...pointers.values()];
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
};

export const usePinchZoom = ({
    enabled,
    layoutRef,
}: PinchZoomOptions): PinchZoomState => {
    const [scale, setScale] = useState(1);
    const [translateX, setTranslateX] = useState(0);
    const [translateY, setTranslateY] = useState(0);
    const [transitionEnabled, setTransitionEnabled] = useState(false);

    const scaleRef = useRef(1);
    useEffect((): void => {
        scaleRef.current = scale;
    }, [scale]);

    const boundsRef = useRef<PanBounds>({
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0,
    });
    const pointersRef = useRef<Map<number, { x: number; y: number }>>(
        new Map(),
    );
    const pinchStartRef = useRef<
        { distance: number; scale: number } | undefined
    >(undefined);
    const panStartRef = useRef<
        { x: number; y: number; translateX: number; translateY: number } |
        undefined
    >(undefined);

    const applyPanBounds = useCallback(
        (container: HTMLElement, image: HTMLImageElement | HTMLVideoElement): void => {
            const containedSize = getObjectContainSize(
                image,
                container.clientWidth,
                container.clientHeight,
            );
            boundsRef.current = computePanBounds(
                container.clientWidth,
                container.clientHeight,
                containedSize.width,
                containedSize.height,
                scale,
            );
            setTranslateX((current: number): number =>
                clamp(
                    current,
                    boundsRef.current.minX,
                    boundsRef.current.maxX,
                ));
            setTranslateY((current: number): number =>
                clamp(
                    current,
                    boundsRef.current.minY,
                    boundsRef.current.maxY,
                ));
        },
        [scale],
    );

    const syncBoundsFromLayout = useCallback((): void => {
        const layout = layoutRef?.current;
        if (!layout || scale <= 1.01) {
            return;
        }
        applyPanBounds(layout.container, layout.image);
    }, [applyPanBounds, layoutRef, scale]);

    const shouldCaptureGestures = useCallback((): boolean => {
        return scaleRef.current > 1.01 || pointersRef.current.size >= 2;
    }, []);

    const initPinchStartIfNeeded = useCallback((): void => {
        if (pointersRef.current.size !== 2) {
            return;
        }
        pinchStartRef.current = {
            distance: pinchDistance(pointersRef.current),
            scale: scaleRef.current,
        };
        panStartRef.current = undefined;
    }, []);

    const getPointerCount = useCallback(
        (): number => pointersRef.current.size,
        [],
    );

    const registerPointer =
        useCallback((pointerId: number, x: number, y: number): void => {
            if (!enabled) {
                return;
            }
            pointersRef.current.set(pointerId, { x, y });
            initPinchStartIfNeeded();
        }, [enabled, initPinchStartIfNeeded]);

    const clearPointers = useCallback((): void => {
        pointersRef.current.clear();
        pinchStartRef.current = undefined;
        panStartRef.current = undefined;
    }, []);

    const reset = useCallback((): void => {
        setTransitionEnabled(false);
        setScale(1);
        setTranslateX(0);
        setTranslateY(0);
        clearPointers();
    }, [clearPointers]);

    const animateZoomTo = useCallback(
        (
            nextScale: number,
            nextTranslateX: number,
            nextTranslateY: number,
        ): void => {
            setTransitionEnabled(true);
            const applyZoom = (): void => {
                setScale(nextScale);
                setTranslateX(nextTranslateX);
                setTranslateY(nextTranslateY);
                window.setTimeout((): void => {
                    setTransitionEnabled(false);
                }, ZOOM_TRANSITION_MS);
            };
            if (scaleRef.current <= 1.01 && nextScale > 1.01) {
                window.requestAnimationFrame((): void => {
                    window.requestAnimationFrame(applyZoom);
                });
                return;
            }
            applyZoom();
        },
        [],
    );

    const updatePanBounds = useCallback(
        (container: HTMLElement, image: HTMLImageElement | HTMLVideoElement): void => {
            if (!enabled || scale <= 1.01) {
                boundsRef.current = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
                return;
            }
            applyPanBounds(container, image);
        },
        [applyPanBounds, enabled, scale],
    );

    const finishGesture = useCallback((): void => {
        if (pointersRef.current.size > 0) {
            return;
        }
        panStartRef.current = undefined;
        pinchStartRef.current = undefined;
        if (scale > 1.01) {
            syncBoundsFromLayout();
        }
    }, [scale, syncBoundsFromLayout]);

    const releasePointer = useCallback(
        (pointerId: number): void => {
            if (!pointersRef.current.has(pointerId)) {
                return;
            }
            pointersRef.current.delete(pointerId);
            if (pointersRef.current.size < 2) {
                pinchStartRef.current = undefined;
            }
            finishGesture();
        },
        [finishGesture],
    );

    const onDoubleTap = useCallback(
        (clientX: number, clientY: number, container: HTMLElement): void => {
            if (!enabled) {
                return;
            }
            if (scaleRef.current > 1.01) {
                animateZoomTo(1, 0, 0);
                clearPointers();
                return;
            }
            const rect = container.getBoundingClientRect();
            const offsetX = clientX - rect.left - rect.width / 2;
            const offsetY = clientY - rect.top - rect.height / 2;
            animateZoomTo(
                DOUBLE_TAP_SCALE,
                -offsetX * (DOUBLE_TAP_SCALE - 1),
                -offsetY * (DOUBLE_TAP_SCALE - 1),
            );
        },
        [animateZoomTo, clearPointers, enabled],
    );

    const onPointerDown =
        useCallback(
            (event: ReactPointerEvent<HTMLElement>): void => {
                if (!enabled) {
                    return;
                }
                pointersRef.current.set(event.pointerId, {
                    x: event.clientX,
                    y: event.clientY,
                });
                if (pointersRef.current.size === 1 && scaleRef.current > 1) {
                    panStartRef.current = {
                        x: event.clientX,
                        y: event.clientY,
                        translateX,
                        translateY,
                    };
                }
                initPinchStartIfNeeded();
                if (!shouldCaptureGestures()) {
                    return;
                }
                setTransitionEnabled(false);
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
            },
            [enabled, initPinchStartIfNeeded, shouldCaptureGestures, translateX, translateY],
        );

    const onPointerMove =
        useCallback(
            (event: ReactPointerEvent<HTMLElement>): void => {
                if (!enabled || !pointersRef.current.has(event.pointerId)) {
                    return;
                }
                pointersRef.current.set(event.pointerId, {
                    x: event.clientX,
                    y: event.clientY,
                });
                if (!shouldCaptureGestures()) {
                    return;
                }
                event.stopPropagation();
                if (pointersRef.current.size === 2 && pinchStartRef.current) {
                    const nextScale = clamp(
                        pinchStartRef.current.scale *
                            (pinchDistance(pointersRef.current) /
                                pinchStartRef.current.distance),
                        MIN_SCALE,
                        MAX_SCALE,
                    );
                    setScale(nextScale);
                    if (nextScale <= 1.01) {
                        // Back at fit size: drop the pan offset, which can no
                        // longer be dragged back at 1x.
                        setTranslateX(0);
                        setTranslateY(0);
                    }
                    return;
                }
                if (
                    pointersRef.current.size === 1 &&
                    panStartRef.current &&
                    scaleRef.current > 1
                ) {
                    const bounds = boundsRef.current;
                    const desiredX =
                        panStartRef.current.translateX +
                        (event.clientX - panStartRef.current.x);
                    const desiredY =
                        panStartRef.current.translateY +
                        (event.clientY - panStartRef.current.y);
                    const clampedX = clamp(
                        desiredX,
                        bounds.minX,
                        bounds.maxX,
                    );
                    const clampedY = clamp(
                        desiredY,
                        bounds.minY,
                        bounds.maxY,
                    );
                    setTranslateX(clampedX);
                    setTranslateY(clampedY);
                }
            },
            [enabled, shouldCaptureGestures],
        );

    const onPointerUp =
        useCallback(
            (event: ReactPointerEvent<HTMLElement>): void => {
                if (!pointersRef.current.has(event.pointerId)) {
                    return;
                }
                if (shouldCaptureGestures()) {
                    event.stopPropagation();
                }
                pointersRef.current.delete(event.pointerId);
                if (pointersRef.current.size < 2) {
                    pinchStartRef.current = undefined;
                }
                finishGesture();
            },
            [finishGesture, shouldCaptureGestures],
        );

    const onWheel = useCallback(
        (event: WheelEvent): void => {
            if (!enabled) {
                return;
            }
            // Trackpad pinch sends ctrlKey; plain mouse wheel should zoom too.
            event.preventDefault();
            event.stopPropagation();
            const intensity =
                event.deltaMode === 1 ? 0.12 : Math.min(0.25, Math.abs(event.deltaY) * 0.0015);
            const delta = event.deltaY > 0 ? -intensity : intensity;
            const nextScale = clamp(
                scaleRef.current + delta,
                MIN_SCALE,
                MAX_SCALE,
            );
            // Update the ref now so wheel events between renders accumulate.
            scaleRef.current = nextScale;
            setScale(nextScale);
            if (nextScale <= 1.01) {
                setTranslateX(0);
                setTranslateY(0);
            }
        },
        [enabled],
    );

    // [Note: Non-passive wheel zoom]
    //
    // React registers wheel listeners as passive, so preventDefault in an
    // onWheel prop cannot stop a trackpad pinch (ctrl+wheel) from zooming the
    // whole page. Attach the listener natively instead.
    const wheelTargetRef =
        useCallback(
            (element: HTMLElement | null): (() => void) | undefined => {
                if (!element) {
                    return undefined;
                }
                element.addEventListener("wheel", onWheel, { passive: false });
                return (): void => {
                    element.removeEventListener("wheel", onWheel);
                };
            },
            [onWheel],
        );

    useEffect((): void => {
        if (scale > 1.01) {
            syncBoundsFromLayout();
        }
    }, [scale, syncBoundsFromLayout]);
    useEffect((): (() => void) => {
        if (!enabled) {
            return (): void => undefined;
        }
        const handleGlobalPointerEnd = (event: PointerEvent): void => {
            releasePointer(event.pointerId);
        };
        window.addEventListener("pointerup", handleGlobalPointerEnd);
        window.addEventListener("pointercancel", handleGlobalPointerEnd);
        return (): void => {
            window.removeEventListener("pointerup", handleGlobalPointerEnd);
            window.removeEventListener("pointercancel", handleGlobalPointerEnd);
        };
    }, [enabled, releasePointer]);
    return {
        scale,
        translateX,
        translateY,
        transitionEnabled,
        getPointerCount,
        onDoubleTap,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        wheelTargetRef,
        registerPointer,
        clearPointers,
        releasePointer,
        reset,
        updatePanBounds,
        transformStyle: {
            transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
            transition: transitionEnabled ?
                `transform ${ZOOM_TRANSITION_MS}ms ease-out` :
                undefined,
        },
    };
};
