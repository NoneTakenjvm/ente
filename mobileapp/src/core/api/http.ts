import { HTTPError } from "ente-base/http";
import { wait } from "ente-utils/promise";
import type { CoreSession } from "../session";
import { authHeadersFor, publicHeaders } from "../session";
import { notifyUnauthorized } from "@/lib/session-invalidation";

const defaultOrigin = "https://api.ente.com";

const rateLimitHeaderPrefixes = [
    "x-ratelimit",
    "retry-after",
    "x-rate-limit",
];

/**
 * Reduce a URL to origin + pathname for logs and errors. Query strings carry
 * auth tokens (`?token=`) and presigned S3 signatures.
 */
export const urlForLog = (url: string): string => {
    try {
        const { origin, pathname } = new URL(url);
        return `${origin}${pathname}`;
    } catch {
        return "(unparseable url)";
    }
};

/** Longest we honour a server `Retry-After` for. */
const maxRetryAfterMs = 60_000;

/** The `Retry-After` delay carried by an {@link HTTPError}, if it has one. */
const retryAfterMs = (error: unknown): number | undefined => {
    const header =
        error instanceof HTTPError ? error.res.headers.get("Retry-After") : null;
    if (!header) {
        return undefined;
    }
    const seconds = Number(header);
    const delayMs = Number.isFinite(seconds) ?
        seconds * 1000 :
        Date.parse(header) - Date.now();
    return Number.isFinite(delayMs) && delayMs >= 0 ?
        Math.min(delayMs, maxRetryAfterMs) :
        undefined;
};

/**
 * True for failures worth retrying: network errors (fetch rejects with a
 * `TypeError`), HTTP 429 and HTTP 5xx. Aborts and other 4xx (including 409)
 * are not transient.
 */
export const isTransientError = (error: unknown): boolean =>
    error instanceof TypeError ||
    (error instanceof HTTPError &&
        (error.res.status === 429 || error.res.status >= 500));

interface RetryOptions {
    /** Total tries, including the first. */
    attempts: number;
    isRetryable: (error: unknown) => boolean;
    /** Delay before the first retry; doubles each retry. Defaults to 1s. */
    baseDelayMs?: number;
    /** Cap on the doubling delay. Defaults to 8s. */
    maxDelayMs?: number;
    /** Checked after each wait so a pending retry stops on abort. */
    signal?: AbortSignal;
}

/**
 * Run {@link op}, retrying retryable failures with exponential backoff. A
 * server `Retry-After` on the failure overrides the computed delay.
 */
export const retryWithBackoff = async <T>(
    op: () => Promise<T>,
    {
        attempts,
        isRetryable,
        baseDelayMs = 1000,
        maxDelayMs = 8000,
        signal,
    }: RetryOptions,
): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
        try {
            return await op();
        } catch (error) {
            if (attempt >= attempts || !isRetryable(error)) {
                throw error;
            }
            await wait(
                retryAfterMs(error) ??
                    Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)),
            );
            signal?.throwIfAborted();
        }
    }
};

export class HttpClient {
    constructor(
        private readonly origin: string,
        private readonly session: CoreSession,
    ) {}

    apiOrigin = (): string => this.origin;

    apiURL = (
        path: string,
        queryParams?: Record<string, string | number | boolean>,
    ): string => {
        const url = new URL(path, this.origin);
        if (queryParams) {
            for (const [key, value] of Object.entries(queryParams)) {
                url.searchParams.set(key, String(value));
            }
        }
        return url.toString();
    };

    logRateLimitHeaders = (res: Response, url: string): void => {
        const label = urlForLog(url);
        const headers: Record<string, string> = {};
        for (const [key, value] of res.headers.entries()) {
            const lower = key.toLowerCase();
            if (rateLimitHeaderPrefixes.some((p) => lower.startsWith(p))) {
                headers[key] = value;
            }
        }
        if (Object.keys(headers).length > 0) {
            console.warn(`[rate-limit] ${label}:`, headers);
        }
        if (res.status === 429) {
            console.warn(
                `[rate-limit] ${label}: HTTP 429 — Retry-After=${res.headers.get("Retry-After") ?? "none"}`,
            );
        }
    };

    ensureOk = (res: Response): void => {
        if (res.status === 401) {
            notifyUnauthorized();
        }
        this.ensurePublicOk(res);
    };

    /**
     * Like {@link ensureOk} for unauthenticated calls, where a 401 means bad
     * credentials (wrong password or 2FA code), not an expired session.
     */
    ensurePublicOk = (res: Response): void => {
        this.logRateLimitHeaders(res, res.url);
        if (!res.ok) {
            throw new HTTPError(res);
        }
    };

    publicHeaders = (): Record<string, string> => publicHeaders();

    authHeaders = (): Record<string, string> => authHeadersFor(this.session);

    publicFetch = async (
        path: string,
        init?: RequestInit,
    ): Promise<Response> => {
        const res = await fetch(this.apiURL(path), {
            ...init,
            headers: { ...publicHeaders(), ...init?.headers },
        });
        this.ensurePublicOk(res);
        return res;
    };

    publicFetchJSON = async <T>(
        path: string,
        init?: RequestInit,
    ): Promise<T> => {
        const res = await this.publicFetch(path, init);
        return (await res.json()) as T;
    };

    authFetch = async (
        path: string,
        queryParams?: Record<string, string | number | boolean>,
        init?: RequestInit,
    ): Promise<Response> => {
        const res = await this.authFetchResponse(path, queryParams, init);
        this.ensureOk(res);
        return res;
    };

    /** Authenticated fetch without throwing on non-2xx (for conflict retry). */
    authFetchResponse = async (
        path: string,
        queryParams?: Record<string, string | number | boolean>,
        init?: RequestInit,
    ): Promise<Response> => {
        const res = await fetch(this.apiURL(path, queryParams), {
            ...init,
            headers: { ...this.authHeaders(), ...init?.headers },
        });
        this.logRateLimitHeaders(res, res.url);
        if (res.status === 401) {
            notifyUnauthorized();
        }
        return res;
    };

    authFetchJSON = async <T>(
        path: string,
        queryParams?: Record<string, string | number | boolean>,
    ): Promise<T> => {
        const res = await this.authFetch(path, queryParams);
        return (await res.json()) as T;
    };
}

export const resolveApiOrigin = (configOrigin?: string): string =>
    configOrigin ?? process.env.NEXT_PUBLIC_ENTE_ENDPOINT ?? defaultOrigin;

export const isProductionEnteOrigin = (origin: string): boolean =>
    origin === defaultOrigin;
