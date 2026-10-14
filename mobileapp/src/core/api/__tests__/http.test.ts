import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPError } from "ente-base/http";
import {
    HttpClient,
    isTransientError,
    retryWithBackoff,
    urlForLog,
} from "@/core/api/http";

describe("urlForLog", () => {
    it("keeps origin and pathname and drops query and hash", () => {
        expect(
            urlForLog("https://s3.example.test/obj/1?token=secret&sig=abc#frag"),
        ).toBe("https://s3.example.test/obj/1");
    });

    it("does not echo an unparseable url", () => {
        expect(urlForLog("not a url?token=secret")).toBe("(unparseable url)");
    });
});

describe("HttpClient.ensurePublicOk", () => {
    it("omits the query string from the thrown error and warning", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const http = new HttpClient("https://api.example.test", {});
        const res = {
            ok: false,
            status: 429,
            statusText: "",
            url: "https://api.example.test/files/preview/1?token=secret",
            headers: new Headers({ "Retry-After": "2" }),
        } as unknown as Response;

        expect(() => http.ensurePublicOk(res)).toThrow(HTTPError);
        expect(() => http.ensurePublicOk(res)).toThrow(
            "(/files/preview/1)",
        );
        expect(() => http.ensurePublicOk(res)).not.toThrow(/secret/);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
        warn.mockRestore();
    });
});

const httpError = (status: number, headers?: Record<string, string>): HTTPError =>
    new HTTPError({
        status,
        statusText: "",
        url: "https://api.example.test/x?token=secret",
        headers: new Headers(headers),
    } as Response);

describe("isTransientError", () => {
    it("retries network errors, 429 and 5xx but not other 4xx", () => {
        expect(isTransientError(new TypeError("Failed to fetch"))).toBe(true);
        expect(isTransientError(httpError(429))).toBe(true);
        expect(isTransientError(httpError(503))).toBe(true);
        expect(isTransientError(httpError(409))).toBe(false);
        expect(isTransientError(httpError(400))).toBe(false);
        expect(isTransientError(new Error("HTTP 500"))).toBe(false);
    });
});

describe("retryWithBackoff", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("retries a retryable failure then returns the result", async () => {
        const op = vi
            .fn()
            .mockRejectedValueOnce(httpError(503))
            .mockResolvedValueOnce("ok");
        const result = retryWithBackoff(op, {
            attempts: 3,
            isRetryable: isTransientError,
        });
        await vi.runAllTimersAsync();
        await expect(result).resolves.toBe("ok");
        expect(op).toHaveBeenCalledTimes(2);
    });

    it("stops on a non-retryable error", async () => {
        const op = vi.fn().mockRejectedValue(httpError(409));
        await expect(
            retryWithBackoff(op, { attempts: 3, isRetryable: isTransientError }),
        ).rejects.toThrow("HTTP 409");
        expect(op).toHaveBeenCalledTimes(1);
    });

    it("throws the last error once attempts are exhausted", async () => {
        const op = vi.fn().mockRejectedValue(httpError(500));
        const result = expect(
            retryWithBackoff(op, { attempts: 3, isRetryable: isTransientError }),
        ).rejects.toThrow("HTTP 500");
        await vi.runAllTimersAsync();
        await result;
        expect(op).toHaveBeenCalledTimes(3);
    });

    it("waits for Retry-After instead of the computed backoff", async () => {
        const op = vi
            .fn()
            .mockRejectedValueOnce(httpError(429, { "Retry-After": "5" }))
            .mockResolvedValueOnce("ok");
        const result = retryWithBackoff(op, {
            attempts: 2,
            isRetryable: isTransientError,
        });
        await vi.advanceTimersByTimeAsync(4_999);
        expect(op).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBe("ok");
    });
});
