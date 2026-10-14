/**
 * One place for "write everything durable now" (tab hide, logout, lock) and
 * "forget this session" (logout, lock, panic). Modules with persisted or
 * session-scoped state register themselves at load, so a module that was never
 * imported simply has nothing to flush or reset.
 */

import { hasSessionCacheKey } from "@/lib/cache-key";

type FlushFn = () => Promise<void> | void;

const flushFns: FlushFn[] = [];
const resetFns: Array<() => void> = [];
let flushChain: Promise<void> = Promise.resolve();
let hideListenerInstalled = false;

/**
 * Register a flush that runs on page hide, logout and lock. Installs the one
 * pagehide / visibilitychange listener on first use.
 */
export const registerFlush = (flush: FlushFn): void => {
    flushFns.push(flush);
    installHideListener();
};

/** Register a reset that runs when the session is cleared (logout, lock, panic). */
export const registerReset = (reset: () => void): void => {
    resetFns.push(reset);
};

/**
 * Await every registered flush. Each runs independently (one failure does not
 * skip the rest) and the first failure is rethrown afterwards. Without the
 * session cache key (locked or logged out) nothing can be encrypted, so this
 * no-ops.
 */
export const flushAll = (): Promise<void> => {
    flushChain = flushChain
        .catch(() => undefined)
        .then(async () => {
            if (!hasSessionCacheKey()) {
                return;
            }
            const results = await Promise.allSettled(
                flushFns.map(async (flush) => flush()),
            );
            const failure = results.find(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );
            if (failure) {
                throw failure.reason;
            }
        });
    return flushChain;
};

/** Run every registered reset; one throwing reset does not skip the rest. */
export const runSessionResets = (): void => {
    for (const reset of resetFns) {
        try {
            reset();
        } catch (error) {
            console.warn("[session-lifecycle] reset failed", error);
        }
    }
};

const installHideListener = (): void => {
    if (typeof window === "undefined" || hideListenerInstalled) {
        return;
    }
    hideListenerInstalled = true;
    const flushOnHide = (): void => {
        flushAll().catch((error: unknown) => {
            console.warn("[session-lifecycle] flush failed", error);
        });
    };
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            flushOnHide();
        }
    });
};
