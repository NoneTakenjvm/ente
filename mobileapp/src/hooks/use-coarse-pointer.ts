import { useSyncExternalStore } from "react";

const COARSE_POINTER_QUERY: string = "(pointer: coarse)";

/**
 * Whether the primary pointing device is coarse (touch). Defaults to true
 * before hydration so the mobile-first PWA does not flash a desktop close
 * control on phones.
 */
export const useCoarsePointer: () => boolean = (): boolean =>
    useSyncExternalStore(
        subscribeCoarsePointer,
        getCoarsePointerSnapshot,
        (): boolean => true,
    );

const getCoarsePointerSnapshot: () => boolean = (): boolean => {
    if (typeof window === "undefined" || !window.matchMedia) {
        return true;
    }
    return window.matchMedia(COARSE_POINTER_QUERY).matches;
};

const subscribeCoarsePointer: (onStoreChange: () => void) => () => void = (
    onStoreChange: () => void,
): (() => void) => {
    if (typeof window === "undefined" || !window.matchMedia) {
        return (): void => {};
    }
    const mediaQuery: MediaQueryList = window.matchMedia(COARSE_POINTER_QUERY);
    mediaQuery.addEventListener("change", onStoreChange);
    return (): void => {
        mediaQuery.removeEventListener("change", onStoreChange);
    };
};
