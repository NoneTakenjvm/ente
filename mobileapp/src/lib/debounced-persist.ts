/** Trailing-debounced, serialized writer; the latest scheduled value wins. */
export interface DebouncedPersist<T> {
    /** Replace the pending value and restart the debounce timer. */
    schedule: (value: T) => void;
    /** Write any pending value now and resolve once all writes have settled. */
    flush: () => Promise<void>;
    /** Drop the pending value without writing. */
    cancel: () => void;
}

/**
 * Debounce `write` by `ms`. Writes never overlap, and a failed write does not
 * block the next one. Failures from timer-driven writes are logged; `flush`
 * rejects if the last write failed so callers can report it.
 */
export const createDebouncedPersist = <T>(
    write: (value: T) => Promise<void> | void,
    ms: number,
): DebouncedPersist<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: { value: T } | undefined;
    let chain: Promise<void> = Promise.resolve();

    const run = (value: T): Promise<void> => {
        chain = chain.catch(() => undefined).then(() => write(value));
        return chain;
    };

    const cancel = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        pending = undefined;
    };

    return {
        schedule: (value: T): void => {
            cancel();
            pending = { value };
            timer = setTimeout(() => {
                timer = undefined;
                const next = pending;
                pending = undefined;
                if (next) {
                    run(next.value).catch((error: unknown) => {
                        console.warn("Debounced persist failed", error);
                    });
                }
            }, ms);
        },
        flush: (): Promise<void> => {
            const next = pending;
            cancel();
            return next ? run(next.value) : chain;
        },
        cancel,
    };
};
