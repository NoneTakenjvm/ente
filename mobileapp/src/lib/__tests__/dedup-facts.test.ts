import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import { dedupGroupFacts } from "@/lib/dedup-facts";
import { stubFile } from "@/test-utils/fixtures";

const photo = (id: number, w: number, h: number, fileSize?: number): EnteFile =>
    stubFile({
        id,
        pubMagicMetadata: { version: 1, count: 2, data: { w, h } },
        info: fileSize === undefined ? undefined : { fileSize },
    } as Partial<EnteFile>);

describe("dedupGroupFacts", () => {
    it("formats dimensions and size and flags the leader on each measure", () => {
        const facts = dedupGroupFacts(
            [photo(1, 4000, 3000, 3_145_728), photo(2, 2000, 1500, 1_048_576)],
            new Set([2]),
            new Map([
                [1, 0.8],
                [2, 0.9],
            ]),
        );
        expect(facts[0]).toMatchObject({
            dimensions: "4000 × 3000",
            size: "3.0 MB",
            quality: 80,
            isFavorite: false,
            hasMostPixels: true,
            isLargestFile: true,
            hasBestQuality: false,
        });
        expect(facts[1]).toMatchObject({
            isFavorite: true,
            hasMostPixels: false,
            hasBestQuality: true,
        });
    });

    it("flags nobody on a tie or when a value is missing", () => {
        const facts = dedupGroupFacts(
            [photo(1, 100, 100, 500), photo(2, 100, 100)],
            new Set(),
            new Map([[1, 0.5]]),
        );
        for (const fact of facts) {
            expect(fact.hasMostPixels).toBe(false);
            expect(fact.isLargestFile).toBe(false);
            expect(fact.hasBestQuality).toBe(false);
        }
        expect(facts[1]!.size).toBeUndefined();
        expect(facts[1]!.quality).toBeUndefined();
    });
});
