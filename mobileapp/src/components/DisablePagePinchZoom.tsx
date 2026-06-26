"use client";

import { useEffect, type JSX } from "react";

/**
 * Best-effort block on iOS page pinch-zoom in installed PWA mode.
 * Safari still allows accessibility zoom in many cases; media viewer pinch-zoom is separate.
 */
export function DisablePagePinchZoom(): JSX.Element | null {
    useEffect((): (() => void) => {
        const isStandalone =
            window.matchMedia("(display-mode: standalone)").matches ||
            ("standalone" in navigator &&
                (navigator as Navigator & { standalone?: boolean }).standalone === true);
        if (!isStandalone) {
            return (): void => undefined;
        }

        const preventGesture = (event: Event): void => {
            event.preventDefault();
        };

        document.addEventListener("gesturestart", preventGesture, { passive: false });
        document.addEventListener("gesturechange", preventGesture, { passive: false });
        document.addEventListener("gestureend", preventGesture, { passive: false });

        return (): void => {
            document.removeEventListener("gesturestart", preventGesture);
            document.removeEventListener("gesturechange", preventGesture);
            document.removeEventListener("gestureend", preventGesture);
        };
    }, []);

    return null;
}
