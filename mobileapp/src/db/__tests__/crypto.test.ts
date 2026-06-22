import { describe, expect, it } from "vitest";
import { fromB64, generateKey, toB64 } from "ente-base/crypto";
import {
    decryptCachePayload,
    deriveCacheKey,
    encryptCachePayload,
} from "@/db/crypto";

describe("cache crypto", () => {
    it("deriveCacheKey is deterministic for the same master key", async () => {
        const masterKey = await generateKey();
        const a = await deriveCacheKey(masterKey);
        const b = await deriveCacheKey(masterKey);
        expect(a).toBe(b);
    });    it("encryptCachePayload round-trips JSON", async () => {
        const masterKey = await generateKey();
        const cacheKey = await deriveCacheKey(masterKey);
        const payload = await encryptCachePayload(
            { files: [{ id: 1, title: "a.jpg" }] },
            cacheKey,
        );
        const decoded = await decryptCachePayload<{ files: { id: number }[] }>(
            payload,
            cacheKey,
        );
        expect(decoded.files[0]?.id).toBe(1);
    });    it("tampered ciphertext throws on decrypt", async () => {
        const masterKey = await generateKey();
        const cacheKey = await deriveCacheKey(masterKey);
        const payload = await encryptCachePayload({ ok: true }, cacheKey);
        const bytes = await fromB64(payload.encryptedData);
        bytes[0] ^= 0xff;
        await expect(
            decryptCachePayload(
                {
                    ...payload,
                    encryptedData: await toB64(bytes),
                },
                cacheKey,
            ),
        ).rejects.toThrow();
    });
});
