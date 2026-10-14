import { useCallback, useEffect, useRef, useState } from "react";

export type BackgroundJobStatus =
    | "idle" |
    "running" |
    "paused" |
    "done" |
    "error";

export interface JobProgress {
    current: number;
    total: number;
}

interface JobHandlers<T> {
    /** The run resolved. `aborted` is true when it stopped early via pause or unmount. */
    onFinish?: (result: T, aborted: boolean) => void;
    /** The run threw and was not aborted. */
    onError?: (error: unknown) => void;
}

export interface Job<P extends JobProgress> {
    status: BackgroundJobStatus;
    /** Latest value reported by the run; `undefined` until it reports. */
    progress: P | undefined;
    /**
     * Start `run`, aborting any previous run. `run` gets the abort signal and a
     * progress reporter that ignores calls once the run is aborted. Handlers
     * fire only while this is still the latest run (not superseded or reset).
     */
    start: <T>(
        run: (signal: AbortSignal, onProgress: (progress: P) => void) => Promise<T>,
        handlers?: JobHandlers<T>,
    ) => void;
    /** Abort the run and mark the job paused; `start` again to resume. */
    pause: () => void;
    /** Abort the run and return to idle. */
    reset: () => void;
}

/**
 * Lifecycle of one cancellable background job local to a component: status,
 * progress, abort on pause/reset/unmount, and a stale run never writes status
 * after a newer start.
 */
export const useJob = <P extends JobProgress = JobProgress>(): Job<P> => {
    const [status, setStatus] = useState<BackgroundJobStatus>("idle");
    const [progress, setProgress] = useState<P | undefined>(undefined);
    const controllerRef = useRef<AbortController | undefined>(undefined);

    useEffect(() => {
        return (): void => {
            controllerRef.current?.abort();
        };
    }, []);

    const start: Job<P>["start"] = useCallback((run, handlers) => {
        controllerRef.current?.abort();
        const controller = new AbortController();
        const { signal } = controller;
        controllerRef.current = controller;
        setStatus("running");
        setProgress(undefined);

        run(signal, (next) => {
            if (!signal.aborted) {
                setProgress(next);
            }
        })
            .then((result) => {
                if (controllerRef.current !== controller) {
                    return;
                }
                handlers?.onFinish?.(result, signal.aborted);
                setStatus(signal.aborted ? "paused" : "done");
            })
            .catch((error: unknown) => {
                if (controllerRef.current !== controller) {
                    return;
                }
                if (signal.aborted) {
                    setStatus("paused");
                    return;
                }
                handlers?.onError?.(error);
                setStatus("error");
            });
    }, []);

    const pause = useCallback((): void => {
        controllerRef.current?.abort();
        setStatus("paused");
    }, []);

    const reset = useCallback((): void => {
        controllerRef.current?.abort();
        controllerRef.current = undefined;
        setStatus("idle");
        setProgress(undefined);
    }, []);

    return { status, progress, start, pause, reset };
};
