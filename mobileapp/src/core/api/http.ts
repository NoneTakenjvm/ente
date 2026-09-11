import type { CoreSession } from "../session";
import { authHeadersFor, publicHeaders } from "../session";
import { notifyUnauthorized } from "@/lib/session-invalidation";

const defaultOrigin = "https://api.ente.com";

const rateLimitHeaderPrefixes = [
    "x-ratelimit",
    "retry-after",
    "x-rate-limit",
];

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

    logRateLimitHeaders = (res: Response, label: string): void => {
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
        this.logRateLimitHeaders(res, res.url);
        if (res.status === 401) {
            notifyUnauthorized();
        }
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${res.url}`);
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
        this.ensureOk(res);
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
