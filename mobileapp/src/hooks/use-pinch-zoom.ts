import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type WheelEvent as ReactWheelEvent,
} from "react";

const MIN_SCALE: number = 1;
const MAX_SCALE: number = 4;
const DOUBLE_TAP_SCALE: number = 3;
const ZOOM_TRANSITION_MS: number = 250;

export interface PanBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

interface PinchLayout {
    container: HTMLElement;
    image: HTMLImageElement;
}

interface PinchZoomOptions {
    enabled: boolean;
    onPanRelease?: (edgeOverflowX: number) => void;
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
    onWheel: (event: ReactWheelEvent<HTMLElement>) => void;
    registerPointer: (pointerId: number, x: number, y: number) => void;
    clearPointers: () => void;
    releasePointer: (pointerId: number) => void;
    reset: () => void;
    updatePanBounds: (
        container: HTMLElement,
        image: HTMLImageElement,
    ) => void;
    transformStyle: { transform: string; transition?: string };
}

const clamp: (value: number, min: number, max: number) => number = (
    value: number,
    min: number,
    max: number,
): number => Math.min(max, Math.max(min, value));

/**
 * Size of an image as rendered with `object-fit: contain` inside a container.
 */
export const getObjectContainSize: (
    media: HTMLImageElement | HTMLVideoElement,
    containerWidth: number,
    containerHeight: number,
) => { width: number; height: number } = (
    media: HTMLImageElement | HTMLVideoElement,
    containerWidth: number,
    containerHeight: number,
): { width: number; height: number } => {
    const naturalWidth: number =
        media instanceof HTMLVideoElement ?
            media.videoWidth :
            media.naturalWidth;
    const naturalHeight: number =
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
    const fitScale: number = Math.min(
        containerWidth / naturalWidth,
        containerHeight / naturalHeight,
    );
    return {
        width: naturalWidth * fitScale,
        height: naturalHeight * fitScale,
    };
};

export const computePanBounds: (
    containerWidth: number,
    containerHeight: number,
    imageWidth: number,
    imageHeight: number,
    scale: number,
) => PanBounds = (
    containerWidth: number,
    containerHeight: number,
    imageWidth: number,
    imageHeight: number,
    scale: number,
): PanBounds => {
    const scaledWidth: number = imageWidth * scale;
    const scaledHeight: number = imageHeight * scale;
    const maxX: number = Math.max(0, (scaledWidth - containerWidth) / 2);
    const maxY: number = Math.max(0, (scaledHeight - containerHeight) / 2);
    return {
        minX: -maxX,
        maxX,
        minY: -maxY,
        maxY,
    };
};

export const usePinchZoom: (options: PinchZoomOptions) => PinchZoomState = ({
    enabled,
    onPanRelease,
    layoutRef,
}: PinchZoomOptions): PinchZoomState => {
    const [scale, setScale]: [number, (value: number | ((current: number) => number)) => void] =
        useState<number>(1);
    const [translateX, setTranslateX]: [
        number,
        (value: number | ((current: number) => number)) => void,
    ] = useState<number>(0);
    const [translateY, setTranslateY]: [
        number,
        (value: number | ((current: number) => number)) => void,
    ] = useState<number>(0);
    const [transitionEnabled, setTransitionEnabled]: [
        boolean,
        (value: boolean) => void,
    ] = useState<boolean>(false);

    const scaleRef: { current: number } = useRef<number>(1);
    useEffect((): void => {
        scaleRef.current = scale;
    }, [scale]);

    const onPanReleaseRef: { current: ((edgeOverflowX: number) => void) | undefined } =
        useRef(onPanRelease);
    useEffect((): void => {
        onPanReleaseRef.current = onPanRelease;
    }, [onPanRelease]);

    const boundsRef: { current: PanBounds } = useRef<PanBounds>({
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0,
    });
    const edgeOverflowAccumRef: { current: number } = useRef<number>(0);
    const pointersRef: { current: Map<number, { x: number; y: number }> } =
        useRef<Map<number, { x: number; y: number }>>(new Map());
    const pinchStartRef: {
        current: { distance: number; scale: number } | undefined;
    } = useRef<{ distance: number; scale: number } | undefined>(undefined);
    const panStartRef: {
        current: { x: number; y: number; translateX: number; translateY: number } |
            undefined;
    } = useRef<
        { x: number; y: number; translateX: number; translateY: number } |
        undefined
    >(undefined);

    const syncBoundsFromLayout: () => void = useCallback((): void => {
        const layout: PinchLayout | null | undefined = layoutRef?.current;
        if (!layout || scale <= 1.01) {
            return;
        }
        const containedSize: { width: number; height: number } = getObjectContainSize(
            layout.image,
            layout.container.clientWidth,
            layout.container.clientHeight,
        );
        boundsRef.current = computePanBounds(
            layout.container.clientWidth,
            layout.container.clientHeight,
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
    }, [layoutRef, scale]);

    const shouldCaptureGestures: () => boolean = useCallback((): boolean => {
        return scaleRef.current > 1.01 || pointersRef.current.size >= 2;
    }, []);

    const initPinchStartIfNeeded: () => void = useCallback((): void => {
        if (pointersRef.current.size !== 2) {
            return;
        }
        const points: { x: number; y: number }[] = [
            ...pointersRef.current.values(),
        ];
        const dx: number = points[0].x - points[1].x;
        const dy: number = points[0].y - points[1].y;
        pinchStartRef.current = {
            distance: Math.hypot(dx, dy),
            scale: scaleRef.current,
        };
        panStartRef.current = undefined;
    }, []);

    const getPointerCount: () => number = useCallback(
        (): number => pointersRef.current.size,
        [],
    );

    const registerPointer: (pointerId: number, x: number, y: number) => void =
        useCallback((pointerId: number, x: number, y: number): void => {
            if (!enabled) {
                return;
            }
            if (pointersRef.current.size === 0) {
                edgeOverflowAccumRef.current = 0;
            }
            pointersRef.current.set(pointerId, { x, y });
            initPinchStartIfNeeded();
        }, [enabled, initPinchStartIfNeeded]);

    const clearPointers: () => void = useCallback((): void => {
        pointersRef.current.clear();
        pinchStartRef.current = undefined;
        panStartRef.current = undefined;
        edgeOverflowAccumRef.current = 0;
    }, []);

    const reset: () => void = useCallback((): void => {
        setTransitionEnabled(false);
        setScale(1);
        setTranslateX(0);
        setTranslateY(0);
        clearPointers();
    }, [clearPointers]);

    const animateZoomTo: (
        nextScale: number,
        nextTranslateX: number,
        nextTranslateY: number,
    ) => void = useCallback(
        (
            nextScale: number,
            nextTranslateX: number,
            nextTranslateY: number,
        ): void => {
            setTransitionEnabled(true);
            const applyZoom: () => void = (): void => {
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

    const updatePanBounds: (
        container: HTMLElement,
        image: HTMLImageElement,
    ) => void = useCallback(
        (container: HTMLElement, image: HTMLImageElement): void => {
            if (!enabled || scale <= 1.01) {
                boundsRef.current = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
                return;
            }
            const containedSize: { width: number; height: number } = getObjectContainSize(
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
        [enabled, scale],
    );

    const finishGesture: () => void = useCallback((): void => {
        if (pointersRef.current.size > 0) {
            return;
        }
        const edgeOverflow: number = edgeOverflowAccumRef.current;
        edgeOverflowAccumRef.current = 0;
        panStartRef.current = undefined;
        pinchStartRef.current = undefined;
        if (scale > 1.01) {
            syncBoundsFromLayout();
            if (edgeOverflow !== 0) {
                onPanReleaseRef.current?.(edgeOverflow);
            }
        }
    }, [scale, syncBoundsFromLayout]);

    const releasePointer: (pointerId: number) => void = useCallback(
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

    const onDoubleTap: (
        clientX: number,
        clientY: number,
        container: HTMLElement,
    ) => void = useCallback(
        (clientX: number, clientY: number, container: HTMLElement): void => {
            if (!enabled) {
                return;
            }
            if (scaleRef.current > 1.01) {
                animateZoomTo(1, 0, 0);
                pointersRef.current.clear();
                pinchStartRef.current = undefined;
                panStartRef.current = undefined;
                edgeOverflowAccumRef.current = 0;
                return;
            }
            const rect: DOMRect = container.getBoundingClientRect();
            const offsetX: number = clientX - rect.left - rect.width / 2;
            const offsetY: number = clientY - rect.top - rect.height / 2;
            animateZoomTo(
                DOUBLE_TAP_SCALE,
                -offsetX * (DOUBLE_TAP_SCALE - 1),
                -offsetY * (DOUBLE_TAP_SCALE - 1),
            );
        },
        [animateZoomTo, enabled],
    );

    const onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void =
        useCallback(
            (event: ReactPointerEvent<HTMLElement>): void => {
                if (!enabled) {
                    return;
                }
                if (pointersRef.current.size === 0) {
                    edgeOverflowAccumRef.current = 0;
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

    const onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void =
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
                    const points: { x: number; y: number }[] = [
                        ...pointersRef.current.values(),
                    ];
                    const dx: number = points[0].x - points[1].x;
                    const dy: number = points[0].y - points[1].y;
                    const distance: number = Math.hypot(dx, dy);
                    const nextScale: number = Math.min(
                        MAX_SCALE,
                        Math.max(
                            MIN_SCALE,
                            pinchStartRef.current.scale *
                            (distance / pinchStartRef.current.distance),
                        ),
                    );
                    setScale(nextScale);
                    return;
                }
                if (
                    pointersRef.current.size === 1 &&
                    panStartRef.current &&
                    scaleRef.current > 1
                ) {
                    const bounds: PanBounds = boundsRef.current;
                    const desiredX: number =
                        panStartRef.current.translateX +
                        (event.clientX - panStartRef.current.x);
                    const desiredY: number =
                        panStartRef.current.translateY +
                        (event.clientY - panStartRef.current.y);
                    const clampedX: number = clamp(
                        desiredX,
                        bounds.minX,
                        bounds.maxX,
                    );
                    const clampedY: number = clamp(
                        desiredY,
                        bounds.minY,
                        bounds.maxY,
                    );
                    const overflowX: number = desiredX - clampedX;
                    setTranslateX(clampedX);
                    setTranslateY(clampedY);
                    if (overflowX !== 0) {
                        edgeOverflowAccumRef.current += overflowX;
                    }
                }
            },
            [enabled, shouldCaptureGestures],
        );

    const onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void =
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

    const onWheel: (event: ReactWheelEvent<HTMLElement>) => void = useCallback(
        (event: ReactWheelEvent<HTMLElement>): void => {
            if (!enabled || !event.ctrlKey) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const delta: number = event.deltaY > 0 ? -0.1 : 0.1;
            setScale((current: number): number =>
                Math.min(MAX_SCALE, Math.max(MIN_SCALE, current + delta)));
        },
        [enabled],
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
        const handleGlobalPointerEnd: (event: PointerEvent) => void = (
            event: PointerEvent,
        ): void => {
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
        onWheel,
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
