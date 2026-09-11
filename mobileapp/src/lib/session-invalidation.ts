/**
 * Session invalidation hook for HTTP 401 — avoids importing session-store from core.
 */

let unauthorizedHandler: (() => void) | undefined;
let unauthorizedNotified = false;

/**
 * Register the single-flight handler invoked on HTTP 401 (typically logout).
 * Passing `undefined` clears the handler; also resets the notify gate.
 */
export const setUnauthorizedHandler = (
    handler: (() => void) | undefined,
): void => {
    unauthorizedHandler = handler;
    unauthorizedNotified = false;
};

/**
 * Fire once per "session death" so parallel 401s do not loop logout.
 */
export const notifyUnauthorized = (): void => {
    if (unauthorizedNotified || !unauthorizedHandler) {
        return;
    }
    unauthorizedNotified = true;
    unauthorizedHandler();
};

/** Reset after a successful login so a later 401 can fire again. */
export const resetUnauthorizedGate = (): void => {
    unauthorizedNotified = false;
};
