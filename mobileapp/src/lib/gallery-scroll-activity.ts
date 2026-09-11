/**
 * Short-lived “gallery is scrolling” signal shared by the grid and thumbnail
 * cache so load concurrency and IDB touches can ease off during flings.
 */

/** How long after the last scroll event we still treat the gallery as moving. */
const SCROLL_IDLE_MS = 160;

let scrollingUntilMs = 0;

/** Call from gallery scroll handlers (grid + fit). */
export const noteGalleryScrollActivity = (): void => {
    scrollingUntilMs = Date.now() + SCROLL_IDLE_MS;
};

/** True while the user is actively scrolling (or just stopped within idle window). */
export const isGalleryScrolling = (): boolean => Date.now() < scrollingUntilMs;

/**
 * Background jobs await this between units of work so flings get CPU/IO
 * (hard-pause scans while the gallery is scrolling).
 */
export const waitWhileGalleryScrolling = async (
    signal?: AbortSignal,
): Promise<void> => {
    while (isGalleryScrolling()) {
        if (signal?.aborted) {
            return;
        }
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
        });
    }
};
