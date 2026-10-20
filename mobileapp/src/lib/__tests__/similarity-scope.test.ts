import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import { similarScopeFiles } from "@/lib/similarity-scope";
import { stubFile } from "@/test-utils/fixtures";

const uploadedAt = (id: number, time: number): EnteFile =>
    stubFile({
        id,
        pubMagicMetadata: { version: 1, count: 1, data: { uploadedAt: time } },
    } as Partial<EnteFile>);

const candidates = [uploadedAt(1, 100), uploadedAt(2, 300), uploadedAt(3, 200)];

const ids = (files: EnteFile[]): number[] => files.map((file) => file.id);

describe("similarScopeFiles", () => {
    it("library keeps every candidate", () => {
        expect(
            ids(similarScopeFiles({ kind: "library" }, candidates, new Set())),
        ).toEqual([1, 2, 3]);
    });

    it("latest keeps the newest uploads, newest first", () => {
        expect(
            ids(
                similarScopeFiles(
                    { kind: "latest", count: 2 },
                    candidates,
                    new Set(),
                ),
            ),
        ).toEqual([2, 3]);
    });

    it("latest larger than the library keeps everything", () => {
        expect(
            similarScopeFiles(
                { kind: "latest", count: 50 },
                candidates,
                new Set(),
            ),
        ).toHaveLength(3);
    });

    it("picked keeps only picked candidates and ignores unknown ids", () => {
        expect(
            ids(
                similarScopeFiles(
                    { kind: "picked" },
                    candidates,
                    new Set([3, 1, 99]),
                ),
            ),
        ).toEqual([1, 3]);
    });
});
