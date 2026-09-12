import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("thumbnail IDB memory guard", () => {
    it("does not call getAll on the thumbnails store", () => {
        const source = readFileSync(
            resolve(__dirname, "../thumbnails.ts"),
            "utf8",
        );
        expect(source).not.toMatch(/\.\s*getAll\s*\(/);
        expect(source).toMatch(/openCursor/);
    });

    it("file-ciphertexts also avoids getAll", () => {
        const source = readFileSync(
            resolve(__dirname, "../file-ciphertexts.ts"),
            "utf8",
        );
        expect(source).not.toMatch(/\.\s*getAll\s*\(/);
        expect(source).toMatch(/openCursor/);
    });

    it("coalesces LRU touches via LruTouchCoalescer", () => {
        for (const name of ["thumbnails.ts", "file-ciphertexts.ts"] as const) {
            const source = readFileSync(resolve(__dirname, `../${name}`), "utf8");
            expect(source).toMatch(/LruTouchCoalescer/);
            expect(source).toMatch(/flushThumbnailLruTouches|flushFileCiphertextLruTouches/);
        }
    });
});
