import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";

declare global {
    interface WorkerGlobalScope extends SerwistGlobalConfig {
        __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
    }
}

declare const self: ServiceWorkerGlobalScope;

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

/**
 * Cross-origin requests (Ente API, thumbnails, files, model and CDN downloads)
 * and a custom Ente endpoint must not go through Serwist's NetworkFirst
 * handlers — authenticated API responses are not cacheable, timeouts surface
 * as FetchEvent "no-response" errors, and transformers.js already caches the
 * large CLIP model files itself.
 */
const remoteCaching: RuntimeCaching[] = [
    {
        matcher: ({ url, sameOrigin }) =>
            !sameOrigin || url.hostname === customEnteApiHostname(),
        handler: new NetworkOnly(),
    },
];

const serwist: Serwist = new Serwist({
    precacheEntries: self.__SW_MANIFEST,
    skipWaiting: true,
    clientsClaim: true,
    navigationPreload: true,
    runtimeCaching: [...remoteCaching, ...defaultCache],
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
