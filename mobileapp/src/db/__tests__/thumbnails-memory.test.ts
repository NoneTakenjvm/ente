import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("blob store IDB memory guard", () => {
    it("never calls getAll and scans eviction candidates by cursor", () => {
        const source = readFileSync(resolve(__dirname, "../blob-store.ts"), "utf8");
        expect(source).not.toMatch(/\.\s*getAll\s*\(/);
        expect(source).toMatch(/openCursor/);
    });

    it("thumbnails and file-ciphertexts go through the shared store", () => {
        for (const name of ["thumbnails.ts", "file-ciphertexts.ts"] as const) {
            const source = readFileSync(resolve(__dirname, `../${name}`), "utf8");
            expect(source).not.toMatch(/\.\s*getAll\s*\(/);
            expect(source).toMatch(/createLruBlobStore/);
        }
    });
});
