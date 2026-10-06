import {
    useCallback,
    useEffect,
    useRef,
    type PointerEvent as ReactPointerEvent,
    type RefCallback,
    type RefObject,
} from "react";
import { noteGalleryScrollActivity } from "@/lib/gallery-scroll-activity";
import {
    MARQUEE_ARM_THRESHOLD_PX,
    contentRectToViewport,
    marqueeEdgeScrollDelta,
    marqueeTouchIntent,
    normalizeRect,
    shouldArmMarquee,
    type MarqueePoint,
    type MarqueeRect,
} from "@/lib/marquee-selection";

export interface MarqueeScrollController {
    /** Current scroll offset (content px). */
    getScrollTop: () => number;
    /** Set absolute scroll offset; clamp inside the scroller. */
    setScrollTop: (next: number) => void;
}

interface UseMarqueeSelectionArgs {
    enabled: boolean;
    scrollControllerRef: RefObject<MarqueeScrollController | null>;
    /**
     * Called whenever the content-space marquee rect changes (armed drag).
     * Use to live-update selection; not called on cancel.
     */
    onMarqueeRect: (rect: MarqueeRect) => void;
    /** Bottom chrome height overlapping the grid; edge scroll starts above it. */
    bottomInsetPx?: number;
}

interface UseMarqueeSelectionResult {
    /** Attach to the grid container (pointer handlers + touch scroll lock). */
    containerRef: RefCallback<HTMLDivElement>;
    /** Attach to an absolutely positioned overlay; styled directly per frame. */
    overlayRef: RefObject<HTMLDivElement | null>;
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

/**
 * Pointer marquee with content-space anchoring and edge auto-scroll.
 *
 * [Note: Marquee on touch screens]
 *
 * Scrollers carry `touch-action: pan-y`, so a vertical swipe scrolls natively
 * (the browser then sends `pointercancel` and the gesture is dropped). A
 * sideways swipe arms the marquee; from then on a non-passive `touchmove`
 * listener calls `preventDefault` so the browser cannot start a pan and the
 * drag keeps extending the selection. React's touch handlers are passive, so
 * that listener is attached natively through the container ref callback.
 */
export function useMarqueeSelection({
    enabled,
    scrollControllerRef,
    onMarqueeRect,
    bottomInsetPx = 0,
}: UseMarqueeSelectionArgs): UseMarqueeSelectionResult {
    const containerNodeRef = useRef<HTMLDivElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const dragStartContentRef = useRef<MarqueePoint | undefined>(undefined);
    const pointerViewportRef = useRef<MarqueePoint | undefined>(undefined);
    const armedRef = useRef(false);
    const pointerIdRef = useRef<number | undefined>(undefined);
    const rafRef = useRef<number>(0);
    const onMarqueeRectRef = useRef(onMarqueeRect);
    const enabledRef = useRef(enabled);
    const bottomInsetRef = useRef(bottomInsetPx);

    useEffect(() => {
        onMarqueeRectRef.current = onMarqueeRect;
        enabledRef.current = enabled;
        bottomInsetRef.current = bottomInsetPx;
    }, [bottomInsetPx, enabled, onMarqueeRect]);

    const containerRef = useCallback(
        (node: HTMLDivElement | null): (() => void) | undefined => {
            containerNodeRef.current = node;
            if (!node || !enabled) {
                return undefined;
            }
            const blockPanWhileArmed = (event: TouchEvent): void => {
                if (armedRef.current && event.cancelable) {
                    event.preventDefault();
                }
            };
            node.addEventListener("touchmove", blockPanWhileArmed, {
                passive: false,
            });
            return (): void => {
                node.removeEventListener("touchmove", blockPanWhileArmed);
                containerNodeRef.current = null;
            };
        },
        [enabled],
    );

    const clearRaf = useCallback((): void => {
        if (rafRef.current !== 0) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
        }
    }, []);

    const publishRect = useCallback((): void => {
        const start = dragStartContentRef.current;
        const pointer = pointerViewportRef.current;
        const scroll = scrollControllerRef.current;
        if (!start || !pointer || !scroll) {
            return;
        }
        const scrollTop = scroll.getScrollTop();
        const contentRect = normalizeRect(start, {
            x: pointer.x,
            y: pointer.y + scrollTop,
        });
        const overlay = overlayRef.current;
        if (overlay) {
            const viewportRect = contentRectToViewport(contentRect, scrollTop);
            overlay.style.left = `${viewportRect.x}px`;
            overlay.style.top = `${viewportRect.y}px`;
            overlay.style.width = `${viewportRect.width}px`;
            overlay.style.height = `${viewportRect.height}px`;
            overlay.style.display = "block";
        }
        onMarqueeRectRef.current(contentRect);
    }, [scrollControllerRef]);

    const edgeScrollDelta = useCallback((): number => {
        const pointer = pointerViewportRef.current;
        const bounds = containerNodeRef.current?.getBoundingClientRect();
        if (!pointer || !bounds) {
            return 0;
        }
        return marqueeEdgeScrollDelta(
            pointer.y,
            bounds.height - bottomInsetRef.current,
        );
    }, []);

    const scheduleEdgeScroll = useCallback((): void => {
        if (rafRef.current !== 0 || edgeScrollDelta() === 0) {
            return;
        }
        const step = (): void => {
            rafRef.current = 0;
            const scroll = scrollControllerRef.current;
            const delta = edgeScrollDelta();
            if (!armedRef.current || !scroll || delta === 0) {
                return;
            }
            const before = scroll.getScrollTop();
            // Programmatic edge-scroll must mark activity so thumbnail loads
            // throttle like a real fling (idle concurrency would thrash IDB).
            noteGalleryScrollActivity();
            scroll.setScrollTop(before + delta);
            if (scroll.getScrollTop() !== before) {
                publishRect();
            }
            rafRef.current = requestAnimationFrame(step);
        };
        rafRef.current = requestAnimationFrame(step);
    }, [edgeScrollDelta, publishRect, scrollControllerRef]);

    const resetGesture = useCallback((): void => {
        clearRaf();
        dragStartContentRef.current = undefined;
        pointerViewportRef.current = undefined;
        armedRef.current = false;
        pointerIdRef.current = undefined;
        if (overlayRef.current) {
            overlayRef.current.style.display = "none";
        }
    }, [clearRaf]);

    useEffect(() => (): void => clearRaf(), [clearRaf]);

    const releaseCapture = (pointerId: number): void => {
        const node = containerNodeRef.current;
        if (node?.hasPointerCapture(pointerId)) {
            node.releasePointerCapture(pointerId);
        }
    };

    const viewportPoint = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): MarqueePoint | undefined => {
        const bounds = containerNodeRef.current?.getBoundingClientRect();
        return bounds ?
            { x: event.clientX - bounds.left, y: event.clientY - bounds.top } :
            undefined;
    };

    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
        if (!enabledRef.current || pointerIdRef.current !== undefined) {
            return;
        }
        if (event.pointerType === "mouse" && event.button !== 0) {
            return;
        }
        const point = viewportPoint(event);
        const scroll = scrollControllerRef.current;
        if (!point || !scroll) {
            return;
        }
        armedRef.current = false;
        pointerIdRef.current = event.pointerId;
        pointerViewportRef.current = point;
        dragStartContentRef.current = {
            x: point.x,
            y: point.y + scroll.getScrollTop(),
        };
    };

    const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
        const start = dragStartContentRef.current;
        if (!start || pointerIdRef.current !== event.pointerId) {
            return;
        }
        const point = viewportPoint(event);
        const scroll = scrollControllerRef.current;
        if (!point || !scroll) {
            return;
        }
        pointerViewportRef.current = point;

        if (!armedRef.current) {
            const dx = point.x - start.x;
            const dy = point.y - (start.y - scroll.getScrollTop());
            if (event.pointerType === "mouse") {
                if (!shouldArmMarquee(dx, dy, MARQUEE_ARM_THRESHOLD_PX)) {
                    return;
                }
            } else {
                const intent = marqueeTouchIntent(dx, dy);
                if (intent === "scroll") {
                    resetGesture();
                    return;
                }
                if (intent === undefined) {
                    return;
                }
            }
            armedRef.current = true;
            containerNodeRef.current?.setPointerCapture(event.pointerId);
        }

        event.preventDefault();
        publishRect();
        scheduleEdgeScroll();
    };

    const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
        if (pointerIdRef.current !== event.pointerId) {
            return;
        }
        if (armedRef.current) {
            const point = viewportPoint(event);
            if (point) {
                pointerViewportRef.current = point;
                publishRect();
            }
            releaseCapture(event.pointerId);
        }
        resetGesture();
    };

    const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
        if (pointerIdRef.current !== event.pointerId) {
            return;
        }
        releaseCapture(event.pointerId);
        resetGesture();
    };

    return {
        containerRef,
        overlayRef,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
    };
}
