import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import { filePixelArea } from "@/lib/file-aspect-ratio";

describe("filePixelArea", () => {
    it("returns width times height", () => {
        const file = {
            id: 1,
            pubMagicMetadata: { data: { w: 4000, h: 3000 } },
        } as EnteFile;
        expect(filePixelArea(file)).toBe(12_000_000);
    });

    it("returns 0 when dimensions are missing", () => {
        expect(filePixelArea({ id: 2 } as EnteFile)).toBe(0);
    });
});
