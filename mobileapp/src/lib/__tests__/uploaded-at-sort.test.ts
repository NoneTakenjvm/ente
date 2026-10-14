import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import { sortFilesByUploadedAt } from "@/lib/uploaded-at-sort";
import { stubFile } from "@/test-utils/fixtures";

const withUploadedAt = (id: number, uploadedAt: number): EnteFile =>
    stubFile({
        id,
        pubMagicMetadata: { version: 1, count: 1, data: { uploadedAt } },
    });

describe("sortFilesByUploadedAt", () => {
    it("returns a copy unchanged for none", () => {
        const files = [stubFile({ id: 1 }), stubFile({ id: 2 })];
        const ordered = sortFilesByUploadedAt(files, "none");
        expect(ordered.map((f) => f.id)).toEqual([1, 2]);
        expect(ordered).not.toBe(files);
    });

    it("sorts newest upload first", () => {
        const files = [withUploadedAt(1, 100), withUploadedAt(2, 500)];
        expect(
            sortFilesByUploadedAt(files, "newest").map((f) => f.id),
        ).toEqual([2, 1]);
    });

    it("sorts oldest upload first", () => {
        const files = [withUploadedAt(2, 500), withUploadedAt(1, 100)];
        expect(
            sortFilesByUploadedAt(files, "oldest").map((f) => f.id),
        ).toEqual([1, 2]);
    });

    it("ignores tag and edit times", () => {
        const tagged = stubFile({
            id: 1,
            pubMagicMetadata: {
                version: 1,
                count: 1,
                data: { uploadedAt: 100, editedAt: 900 },
            },
        });
        const files = [tagged, withUploadedAt(2, 500)];
        expect(
            sortFilesByUploadedAt(files, "newest").map((f) => f.id),
        ).toEqual([2, 1]);
    });
});
