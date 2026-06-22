import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";

declare global {
    interface WorkerGlobalScope extends SerwistGlobalConfig {
        __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
    }
}

declare const self: ServiceWorkerGlobalScope;

const enteProductionHosts = new Set([
    "api.ente.com",
    "thumbnails.ente.com",
    "files.ente.com",
]);

const customEnteApiHostname = (): string | undefined => {
    const endpoint = process.env.NEXT_PUBLIC_ENTE_ENDPOINT;
    if (!endpoint) {
        return undefined;
    }
    try {
        return new URL(endpoint).hostname;
    } catch {
        return undefined;
    }
};

const isEnteRemoteRequest = (url: URL): boolean => {
    if (enteProductionHosts.has(url.hostname)) {
        return true;
    }
    const customHost = customEnteApiHostname();
    return customHost !== undefined && url.hostname === customHost;
};

/**
 * Ente sync, metadata writes, and media fetches must not go through
 * Serwist's cross-origin NetworkFirst handler — authenticated API responses
 * are not cacheable and timeouts surface as FetchEvent "no-response" errors.
 */
const enteRemoteCaching: RuntimeCaching[] = [
    {
        matcher: ({ url }) => isEnteRemoteRequest(url),
        handler: new NetworkOnly(),
    },
];

const serwist: Serwist = new Serwist({
    precacheEntries: self.__SW_MANIFEST,
    skipWaiting: true,
    clientsClaim: true,
    navigationPreload: true,
    runtimeCaching: [...enteRemoteCaching, ...defaultCache],
    fallbacks: {
        entries: [
            {
                url: "/offline",
                matcher({ request }: { request: Request }): boolean {
                    return request.destination === "document";
                },
            },
        ],
    },
});

serwist.addEventListeners();
