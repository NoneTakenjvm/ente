import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
} from "react";
import { noteGalleryScrollActivity } from "@/lib/gallery-scroll-activity";
import {
    MARQUEE_ARM_THRESHOLD_PX,
    contentRectToViewport,
    marqueeEdgeScrollDelta,
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
    containerRef: RefObject<HTMLDivElement | null>;
    scrollControllerRef: RefObject<MarqueeScrollController | null>;
    /**
     * Called whenever the content-space marquee rect changes (armed drag).
     * Use to live-update selection; final call may be omitted on cancel.
     */
    onMarqueeRect: (rect: MarqueeRect) => void;
}

interface UseMarqueeSelectionResult {
    /** Viewport-space overlay rect (undefined when idle). */
    marqueeViewport: MarqueeRect | undefined;
    marqueeArmed: boolean;
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

/**
 * Pointer marquee with content-space anchoring and edge auto-scroll.
 */
export function useMarqueeSelection({
    enabled,
    containerRef,
    scrollControllerRef,
    onMarqueeRect,
}: UseMarqueeSelectionArgs): UseMarqueeSelectionResult {
    const dragStartContentRef = useRef<MarqueePoint | undefined>(undefined);
    const pointerViewportRef = useRef<MarqueePoint | undefined>(undefined);
    const armedRef = useRef(false);
    const pointerIdRef = useRef<number | undefined>(undefined);
    const rafRef = useRef<number>(0);
    const onMarqueeRectRef = useRef(onMarqueeRect);
    const enabledRef = useRef(enabled);

    const [marqueeArmed, setMarqueeArmed] = useState(false);
    const [marqueeViewport, setMarqueeViewport] = useState<
        MarqueeRect | undefined
    >();

    useEffect(() => {
        onMarqueeRectRef.current = onMarqueeRect;
    }, [onMarqueeRect]);

    useEffect(() => {
        enabledRef.current = enabled;
    }, [enabled]);

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
        const contentEnd = { x: pointer.x, y: pointer.y + scrollTop };
        const contentRect = normalizeRect(start, contentEnd);
        setMarqueeViewport(contentRectToViewport(contentRect, scrollTop));
        onMarqueeRectRef.current(contentRect);
    }, [scrollControllerRef]);

    const scheduleEdgeScroll = useCallback((): void => {
        if (rafRef.current !== 0) {
            return;
        }
        const step = (): void => {
            rafRef.current = 0;
            if (!armedRef.current) {
                return;
            }
            const pointer = pointerViewportRef.current;
            const scroll = scrollControllerRef.current;
            const bounds = containerRef.current?.getBoundingClientRect();
            if (!pointer || !scroll || !bounds) {
                return;
            }
            const delta = marqueeEdgeScrollDelta(pointer.y, bounds.height);
            if (delta === 0) {
                return;
            }
            // Programmatic edge-scroll must mark activity so thumbnail loads
            // throttle like a real fling (idle concurrency would thrash IDB).
            noteGalleryScrollActivity();
            scroll.setScrollTop(Math.max(0, scroll.getScrollTop() + delta));
            publishRect();
            rafRef.current = requestAnimationFrame(step);
        };
        const pointer = pointerViewportRef.current;
        const bounds = containerRef.current?.getBoundingClientRect();
        if (!pointer || !bounds) {
            return;
        }
        if (marqueeEdgeScrollDelta(pointer.y, bounds.height) === 0) {
            return;
        }
        rafRef.current = requestAnimationFrame(step);
    }, [containerRef, publishRect, scrollControllerRef]);

    const resetGesture = useCallback((): void => {
        clearRaf();
        dragStartContentRef.current = undefined;
        pointerViewportRef.current = undefined;
        armedRef.current = false;
        pointerIdRef.current = undefined;
        setMarqueeArmed(false);
        setMarqueeViewport(undefined);
    }, [clearRaf]);

    useEffect(() => (): void => clearRaf(), [clearRaf]);

    const onPointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>): void => {
            if (!enabledRef.current) {
                return;
            }
            if (event.pointerType === "mouse" && event.button !== 0) {
                return;
            }
            const bounds = containerRef.current?.getBoundingClientRect();
            const scroll = scrollControllerRef.current;
            if (!bounds || !scroll) {
                return;
            }
            const x = event.clientX - bounds.left;
            const y = event.clientY - bounds.top;
            const scrollTop = scroll.getScrollTop();
            armedRef.current = false;
            pointerIdRef.current = event.pointerId;
            pointerViewportRef.current = { x, y };
            dragStartContentRef.current = { x, y: y + scrollTop };
        },
        [containerRef, scrollControllerRef],
    );

    const onPointerMove = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>): void => {
            const start = dragStartContentRef.current;
            if (!start || pointerIdRef.current !== event.pointerId) {
                return;
            }
            const bounds = containerRef.current?.getBoundingClientRect();
            const scroll = scrollControllerRef.current;
            if (!bounds || !scroll) {
                return;
            }
            const x = event.clientX - bounds.left;
            const y = event.clientY - bounds.top;
            pointerViewportRef.current = { x, y };

            if (!armedRef.current) {
                const scrollTop = scroll.getScrollTop();
                const startViewportY = start.y - scrollTop;
                const dx = x - start.x;
                const dy = y - startViewportY;
                if (!shouldArmMarquee(dx, dy, MARQUEE_ARM_THRESHOLD_PX)) {
                    return;
                }
                armedRef.current = true;
                setMarqueeArmed(true);
                event.preventDefault();
                containerRef.current?.setPointerCapture(event.pointerId);
                publishRect();
                scheduleEdgeScroll();
                return;
            }

            event.preventDefault();
            publishRect();
            scheduleEdgeScroll();
        },
        [containerRef, publishRect, scheduleEdgeScroll, scrollControllerRef],
    );

    const onPointerUp = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>): void => {
            if (pointerIdRef.current !== event.pointerId) {
                return;
            }
            if (armedRef.current) {
                const bounds = containerRef.current?.getBoundingClientRect();
                const scroll = scrollControllerRef.current;
                if (bounds && scroll && dragStartContentRef.current) {
                    const x = event.clientX - bounds.left;
                    const y = event.clientY - bounds.top;
                    pointerViewportRef.current = { x, y };
                    publishRect();
                }
                containerRef.current?.releasePointerCapture(event.pointerId);
            }
            resetGesture();
        },
        [containerRef, publishRect, resetGesture, scrollControllerRef],
    );

    return {
        marqueeViewport,
        marqueeArmed,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
    };
}
