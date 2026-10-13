export interface WorkerIdleTimer {
    /** Mark a request as started; cancels any pending terminate. */
    begin: () => void;
    /** Mark a request as finished; schedules terminate once none remain. */
    end: () => void;
    /** Cancel any pending terminate, e.g. on explicit teardown. */
    clear: () => void;
}

/**
 * Create a timer that calls `terminate` after `delayMs` with no request in
 * flight, so a lazily created worker is released between bursts of work.
 *
 * Every {@link WorkerIdleTimer.begin} must be paired with one
 * {@link WorkerIdleTimer.end}, including on failure paths.
 */
export const createWorkerIdleTimer = (
    delayMs: number,
    terminate: () => void,
): WorkerIdleTimer => {
    let inFlight = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clear = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    return {
        begin: (): void => {
            inFlight += 1;
            clear();
        },
        end: (): void => {
            inFlight -= 1;
            if (inFlight > 0) {
                return;
            }
            clear();
            timer = setTimeout(() => {
                timer = undefined;
                terminate();
            }, delayMs);
        },
        clear,
    };
};
