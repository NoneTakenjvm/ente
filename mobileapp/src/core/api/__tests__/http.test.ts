import { describe, expect, it, vi } from "vitest";
import { HttpClient, urlForLog } from "@/core/api/http";

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
            url: "https://api.example.test/files/preview/1?token=secret",
            headers: new Headers({ "Retry-After": "2" }),
        } as unknown as Response;

        expect(() => http.ensurePublicOk(res)).toThrow(
            "HTTP 429 for https://api.example.test/files/preview/1",
        );
        expect(() => http.ensurePublicOk(res)).not.toThrow(/secret/);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
        warn.mockRestore();
    });
});
