import { describe, expect, it } from "vitest";
import {
    ALL_TAG_TYPES_TAB,
    DEFAULT_TAG_TYPE,
    normalizeTagTypeName,
    sortTagsByUsage,
    tagsForTypeView,
    typeForTag,
} from "@/lib/tag-types";

describe("tag-types", () => {
    it("typeForTag falls back to default", () => {
        const map = new Map([["selfie", "people"]]);
        expect(typeForTag("selfie", map)).toBe("people");
        expect(typeForTag("unknown", map)).toBe(DEFAULT_TAG_TYPE);
    });

    it("sortTagsByUsage orders by count then name", () => {
        const fileIdsByTag = new Map<string, Set<number>>([
            ["a", new Set([1])],
            ["b", new Set([1, 2, 3])],
            ["c", new Set([1, 2])],
        ]);
        expect(sortTagsByUsage(["a", "b", "c"], fileIdsByTag)).toEqual([
            "b",
            "c",
            "a",
        ]);
    });

    it("tagsForTypeView filters by type and sorts by usage", () => {
        const fileIdsByTag = new Map<string, Set<number>>([
            ["selfie", new Set([1, 2])],
            ["vietnam", new Set([1])],
            ["beach", new Set([1, 2, 3])],
        ]);
        const tagTypeByName = new Map([
            ["selfie", "people"],
            ["vietnam", "place"],
            ["beach", "place"],
        ]);
        expect(
            tagsForTypeView(
                ["selfie", "vietnam", "beach"],
                tagTypeByName,
                "place",
                fileIdsByTag,
            ),
        ).toEqual(["beach", "vietnam"]);
        expect(
            tagsForTypeView(
                ["selfie", "vietnam", "beach"],
                tagTypeByName,
                ALL_TAG_TYPES_TAB,
                fileIdsByTag,
            ),
        ).toEqual(["beach", "selfie", "vietnam"]);
    });

    it("normalizeTagTypeName trims and rejects empty", () => {
        expect(normalizeTagTypeName("  people  ")).toBe("people");
        expect(normalizeTagTypeName("   ")).toBeUndefined();
    });
});
