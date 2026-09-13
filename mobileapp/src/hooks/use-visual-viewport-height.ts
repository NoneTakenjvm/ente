"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live visual-viewport height for the app shell. On iOS PWAs, `100dvh` can be
 * short on first paint until a resize/scroll; binding height here fills the gap
 * under the bottom nav.
 */
export function useVisualViewportHeight(): number {
    const [height, setHeight] = useState<number>(() => {
        if (typeof window === "undefined") {
            return 0;
        }
        return Math.round(window.visualViewport?.height ?? window.innerHeight);
    });
    const frameRef = useRef<number | undefined>(undefined);

    const measure = useCallback((): void => {
        if (frameRef.current !== undefined) {
            cancelAnimationFrame(frameRef.current);
        }
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = undefined;
            const next = Math.round(
                window.visualViewport?.height ?? window.innerHeight,
            );
            setHeight((current) => (current === next ? current : next));
        });
    }, []);

    useEffect(() => {
        measure();
        const vv = window.visualViewport;
        vv?.addEventListener("resize", measure);
        vv?.addEventListener("scroll", measure);
        window.addEventListener("resize", measure);
        window.addEventListener("pageshow", measure);
        return (): void => {
            if (frameRef.current !== undefined) {
                cancelAnimationFrame(frameRef.current);
            }
            vv?.removeEventListener("resize", measure);
            vv?.removeEventListener("scroll", measure);
            window.removeEventListener("resize", measure);
            window.removeEventListener("pageshow", measure);
        };
    }, [measure]);

    return height;
}
