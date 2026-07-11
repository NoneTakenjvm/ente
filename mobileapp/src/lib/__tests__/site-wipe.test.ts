/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

describe("wipeSiteStorage", () => {
    afterEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        vi.restoreAllMocks();
    });

    it("clears ntphotos and mobileapp storage keys", async () => {
        localStorage.setItem("ntphotos-session", "x");
        localStorage.setItem("ntphotos-wrap-key", "y");
        localStorage.setItem("mobileapp-video-volume", "0.5");
        localStorage.setItem("unrelated-key", "keep");
        sessionStorage.setItem("ntphotos-locked", "1");
        sessionStorage.setItem("other", "keep");

        vi.stubGlobal("indexedDB", {
            databases: async () => [],
            deleteDatabase: () => {
                const request = {
                    onsuccess: null as (() => void) | null,
                    onerror: null as (() => void) | null,
                    onblocked: null as (() => void) | null,
                    error: null,
                };
                queueMicrotask(() => request.onsuccess?.());
                return request;
            },
        });
        vi.stubGlobal("caches", {
            keys: async () => ["sw-cache"],
            delete: vi.fn(async () => true),
        });
        Object.defineProperty(navigator, "serviceWorker", {
            configurable: true,
            value: {
                getRegistrations: async () => [
                    { unregister: vi.fn(async () => true) },
                ],
            },
        });

        const { wipeSiteStorage } = await import("@/lib/site-wipe");
        await wipeSiteStorage();

        expect(localStorage.getItem("ntphotos-session")).toBeNull();
        expect(localStorage.getItem("ntphotos-wrap-key")).toBeNull();
        expect(localStorage.getItem("mobileapp-video-volume")).toBeNull();
        expect(localStorage.getItem("unrelated-key")).toBe("keep");
        expect(sessionStorage.getItem("ntphotos-locked")).toBeNull();
        expect(sessionStorage.getItem("other")).toBe("keep");
        expect(caches.delete).toHaveBeenCalledWith("sw-cache");
    });
});
