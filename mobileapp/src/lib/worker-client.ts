import { createWorkerIdleTimer } from "@/lib/worker-idle-timer";

export interface WorkerClientOptions {
    /**
     * Build one worker. Keep the literal `new Worker(new URL(..., import.meta.url))`
     * at the call site so the bundler can find the worker entry.
     */
    createWorker: () => Worker;
    /** Workers in the round-robin pool; defaults to 1. */
    poolSize?: number;
    /** Terminate the pool after this long with no request in flight. */
    idleMs?: number;
    /**
     * Replace the pool after this many requests so a long scan does not grow
     * decode memory forever. Old workers finish their pending requests first.
     */
    recycleAfter?: number;
    /** Terminate the pool, rejecting everything pending, if one request takes this long. */
    timeoutMs?: number;
    /** Rejection reason for a timeout. */
    timeoutError?: () => Error;
}

/** Drops the `id` the client assigns, distributing over unions of requests. */
type WithoutId<Request> = Request extends unknown ?
    Omit<Request, "id"> :
    never;

export interface WorkerClient<
    Request extends { id: number },
    Response extends { id: number },
> {
    /** Post a request (the client adds its `id`) and resolve with the reply carrying that `id`. */
    request: (
        message: WithoutId<Request>,
        transfer?: Transferable[],
    ) => Promise<Response>;
    /**
     * Terminate every worker and reject all pending requests with `reason`.
     * The next request lazily creates a fresh pool.
     */
    terminate: (reason?: Error) => void;
}

type PendingRequest<Response> = {
    worker: Worker;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Request/response messaging over a lazily created pool of workers.
 *
 * Replies are matched to requests by `id`. A worker error, an unreadable
 * reply, a timeout or {@link WorkerClient.terminate} tears the whole pool down
 * and rejects every pending request, so no caller waits forever on a dead
 * worker.
 */
export const createWorkerClient = <
    Request extends { id: number },
    Response extends { id: number },
>(
    options: WorkerClientOptions,
): WorkerClient<Request, Response> => {
    let workers: Worker[] | undefined;
    /** Replaced workers that are still answering their last requests. */
    const retiring = new Set<Worker>();
    let nextWorkerIndex = 0;
    let requestsToPool = 0;
    let requestCounter = 0;
    const pending = new Map<number, PendingRequest<Response>>();
    const idleTimer =
        options.idleMs === undefined ?
            undefined :
            createWorkerIdleTimer(options.idleMs, () => terminate());

    /** Remove and return a pending request, releasing its timeout and idle hold. */
    const settle = (id: number): PendingRequest<Response> | undefined => {
        const request = pending.get(id);
        if (!request) {
            return undefined;
        }
        pending.delete(id);
        clearTimeout(request.timer);
        idleTimer?.end();
        if (
            retiring.has(request.worker) &&
            ![...pending.values()].some((other) => other.worker === request.worker)
        ) {
            retiring.delete(request.worker);
            request.worker.terminate();
        }
        return request;
    };

    const terminate = (reason = new Error("Worker terminated")): void => {
        workers?.forEach((worker) => {
            worker.terminate();
        });
        retiring.forEach((worker) => {
            worker.terminate();
        });
        retiring.clear();
        workers = undefined;
        nextWorkerIndex = 0;
        for (const id of [...pending.keys()]) {
            settle(id)?.reject(reason);
        }
        idleTimer?.clear();
    };

    const createPool = (): Worker[] =>
        Array.from({ length: options.poolSize ?? 1 }, () => {
            const worker = options.createWorker();
            worker.onmessage = (event: MessageEvent<Response>): void => {
                settle(event.data.id)?.resolve(event.data);
            };
            worker.onerror = (event: ErrorEvent): void => {
                terminate(new Error(event.message || "Worker failed"));
            };
            worker.onmessageerror = (): void => {
                terminate(new Error("Worker reply unreadable"));
            };
            return worker;
        });

    /** Stop routing to the current pool; idle workers go now, busy ones when drained. */
    const retirePool = (): void => {
        for (const worker of workers ?? []) {
            if ([...pending.values()].some((other) => other.worker === worker)) {
                retiring.add(worker);
            } else {
                worker.terminate();
            }
        }
        workers = undefined;
    };

    const request: WorkerClient<Request, Response>["request"] = (
        message,
        transfer = [],
    ) =>
        new Promise((resolve, reject) => {
            if (typeof Worker === "undefined") {
                reject(new Error("Workers are not available"));
                return;
            }
            if (
                options.recycleAfter !== undefined &&
                requestsToPool >= options.recycleAfter
            ) {
                retirePool();
            }
            if (!workers) {
                workers = createPool();
                nextWorkerIndex = 0;
                requestsToPool = 0;
            }
            requestsToPool += 1;
            const worker = workers[nextWorkerIndex % workers.length]!;
            nextWorkerIndex += 1;
            const id = ++requestCounter;
            idleTimer?.begin();
            const timer =
                options.timeoutMs === undefined ?
                    undefined :
                    setTimeout(() => {
                        terminate(
                            options.timeoutError?.() ??
                                new Error("Worker request timed out"),
                        );
                    }, options.timeoutMs);
            pending.set(id, { worker, resolve, reject, timer });
            try {
                worker.postMessage({ ...message, id }, transfer);
            } catch (error: unknown) {
                settle(id);
                reject(
                    error instanceof Error ?
                        error :
                        new Error("Worker post failed"),
                );
            }
        });

    return { request, terminate };
};
