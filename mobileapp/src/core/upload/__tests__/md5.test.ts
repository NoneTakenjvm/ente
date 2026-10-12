import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeMd5Base64, createMd5 } from "@/core/upload/md5";

const nodeMd5Base64 = (data: Uint8Array): string =>
    createHash("md5").update(data).digest("base64");

const lengths = [
    0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4097, 1_000_000,
];

const pieceSizes = [1, 63, 64, 65, 7, 3, 200];

describe("md5", () => {
    it("matches node for one-shot digests", () => {
        for (const length of lengths) {
            const data = new Uint8Array(randomBytes(length));
            expect(computeMd5Base64(data), `length ${length}`).toBe(
                nodeMd5Base64(data),
            );
        }
    });

    it("matches node when fed in uneven pieces", () => {
        for (const length of lengths) {
            const data = new Uint8Array(randomBytes(length));
            const md5 = createMd5();
            let offset = 0;
            for (let i = 0; offset < data.length; i++) {
                const size = pieceSizes[i % pieceSizes.length]!;
                md5.update(data.subarray(offset, offset + size));
                offset += size;
            }
            expect(md5.digestBase64(), `length ${length}`).toBe(
                nodeMd5Base64(data),
            );
        }
    });

    it("handles empty updates between pieces", () => {
        const data = new Uint8Array(randomBytes(150));
        const md5 = createMd5();
        md5.update(data.subarray(0, 10));
        md5.update(new Uint8Array(0));
        md5.update(data.subarray(10));
        expect(md5.digestBase64()).toBe(nodeMd5Base64(data));
    });

    it("handles inputs that start at an unaligned byte offset", () => {
        const buffer = new Uint8Array(randomBytes(1003));
        const unaligned = buffer.subarray(3);
        expect(computeMd5Base64(unaligned)).toBe(nodeMd5Base64(unaligned));

        const md5 = createMd5();
        md5.update(buffer.subarray(1, 100));
        md5.update(buffer.subarray(100));
        expect(md5.digestBase64()).toBe(nodeMd5Base64(buffer.subarray(1)));
    });
});
