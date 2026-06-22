import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    addTagNames,
    mergeTagNames,
    normalizeTagName,
    removeTagNames,
    replaceTagName,
    tagsForFile,
    tagsEqual,
} from "@/lib/tag-writes";

const fileWithTags = (tags: string[]): EnteFile =>
    ({
        id: 1,
        pubMagicMetadata: {
            version: 1,
            count: 1,
            data: { _organizer_v1: { tags, updatedAt: 1 } },
        },
    }) as unknown as EnteFile;

describe("tag-writes", () => {
    it("normalizeTagName trims and rejects empty", () => {
        expect(normalizeTagName("  selfie  ")).toBe("selfie");
        expect(normalizeTagName("   ")).toBeUndefined();
    });

    it("addTagNames dedupes", () => {
        expect(addTagNames(["a"], "b", "a")).toEqual(["a", "b"]);
    });

    it("removeTagNames removes selected tags", () => {
        expect(removeTagNames(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    });

    it("replaceTagName renames one tag", () => {
        expect(replaceTagName(["old", "keep"], "old", "new")).toEqual([
            "new",
            "keep",
        ]);
    });

    it("mergeTagNames unions into target", () => {
        expect(
            mergeTagNames(["a", "b", "c"], ["a", "b"], "merged"),
        ).toEqual(["c", "merged"]);
    });

    it("tagsForFile applies mutator to file tags", () => {
        expect(
            tagsForFile(fileWithTags(["x"]), (tags) => addTagNames(tags, "y")),
        ).toEqual(["x", "y"]);
    });

    it("tagsEqual compares tag sets regardless of order", () => {
        expect(tagsEqual(["a", "b"], ["b", "a"])).toBe(true);
        expect(tagsEqual(["a"], ["a", "b"])).toBe(false);
    });
});
