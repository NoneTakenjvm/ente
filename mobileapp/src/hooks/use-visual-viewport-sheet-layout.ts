import {
    useCallback,
    useEffect,
    useRef,
    useSyncExternalStore,
    type MutableRefObject,
} from "react";

export interface VisualViewportSheetLayout {
    bottomInset: number;
    heightPx: number;
}

const INACTIVE_LAYOUT: VisualViewportSheetLayout = {
    bottomInset: 0,
    heightPx: 0,
};

const readLayout: (heightRatio: number) => VisualViewportSheetLayout = (
    heightRatio: number,
): VisualViewportSheetLayout => {
    const vv: VisualViewport | null = window.visualViewport;
    if (!vv) {
        const height: number = window.innerHeight;
        const heightPx: number = Math.round(height * heightRatio);
        return { bottomInset: 0, heightPx };
    }
    const heightPx: number = Math.round(vv.height * heightRatio);
    const bottomInset: number = Math.max(
        0,
        window.innerHeight - vv.offsetTop - vv.height,
    );
    return { bottomInset, heightPx };
};

const emptySubscribe: () => () => void = (): (() => void) => (): void => {};

export type VisualViewportSheetSyncResult = VisualViewportSheetLayout & {
    syncLayout: () => void;
};

const isStaleViewportOffset: (
    vv: VisualViewport,
    maxVisualHeight: number,
) => boolean = (vv: VisualViewport, maxVisualHeight: number): boolean =>
    vv.offsetTop > 0 && vv.height >= maxVisualHeight - 4;

const resetStaleViewportScroll: () => void = (): void => {
    window.scrollTo(0, 0);
};

/**
 * Bottom-anchor the tag picker to the visible viewport using visualViewport
 * height and keyboard inset. Avoids `top` positioning (jumps during the iOS
 * keyboard animation) and avoids `dvh` (lags behind the keyboard on iOS).
 */
export const useVisualViewportSheetLayout: (
    active: boolean,
    heightRatio: number,
) => VisualViewportSheetSyncResult = (
    active: boolean,
    heightRatio: number,
): VisualViewportSheetSyncResult => {
    const cacheRef: MutableRefObject<VisualViewportSheetLayout> =
        useRef<VisualViewportSheetLayout>(INACTIVE_LAYOUT);
    const maxHeightRef: MutableRefObject<number> = useRef<number>(0);

    useEffect((): void => {
        if (!active) {
            maxHeightRef.current = 0;
        }
    }, [active]);

    const resetStaleViewportIfNeeded: () => void = useCallback((): void => {
        const vv: VisualViewport | null = window.visualViewport;
        if (!vv || !active) {
            return;
        }
        maxHeightRef.current = Math.max(maxHeightRef.current, vv.height);
        if (isStaleViewportOffset(vv, maxHeightRef.current)) {
            resetStaleViewportScroll();
        }
    }, [active]);

    const getSnapshot: () => VisualViewportSheetLayout = useCallback((): VisualViewportSheetLayout => {
        if (!active) {
            return INACTIVE_LAYOUT;
        }
        const next: VisualViewportSheetLayout = readLayout(heightRatio);
        const cached: VisualViewportSheetLayout = cacheRef.current;
        if (
            cached.bottomInset === next.bottomInset &&
            cached.heightPx === next.heightPx
        ) {
            return cached;
        }
        cacheRef.current = next;
        return next;
    }, [active, heightRatio]);

    const subscribeViewport: (onChange: () => void) => () => void =
        useCallback(
            (onChange: () => void): (() => void) => {
                const vv: VisualViewport | null = window.visualViewport;
                const handler: () => void = (): void => {
                    resetStaleViewportIfNeeded();
                    onChange();
                };
                vv?.addEventListener("resize", handler);
                vv?.addEventListener("scroll", handler);
                window.addEventListener("resize", handler);
                return (): void => {
                    vv?.removeEventListener("resize", handler);
                    vv?.removeEventListener("scroll", handler);
                    window.removeEventListener("resize", handler);
                };
            },
            [resetStaleViewportIfNeeded],
        );

    const layout: VisualViewportSheetLayout = useSyncExternalStore(
        active ? subscribeViewport : emptySubscribe,
        getSnapshot,
        (): VisualViewportSheetLayout => INACTIVE_LAYOUT,
    );

    const syncLayout: () => void = useCallback((): void => {
        resetStaleViewportIfNeeded();
        window.dispatchEvent(new Event("resize"));
        window.visualViewport?.dispatchEvent(new Event("resize"));
    }, [resetStaleViewportIfNeeded]);
    return { ...layout, syncLayout };
};
