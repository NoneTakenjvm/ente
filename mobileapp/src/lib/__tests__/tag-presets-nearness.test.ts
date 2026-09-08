import { describe, expect, it } from "vitest";
import {
    matchNearnessFilterToKitPreset,
    nearnessFilterFromKitTags,
    stampTagsFromNearnessFilter,
} from "@/lib/tag-presets";
import { emptyTagFilter } from "@/lib/tags";
import { setKitTagsModeOnFilter } from "@/lib/tag-filter-mutations";

describe("matchNearnessFilterToKitPreset", () => {
    const presets = [
        { id: "k1", name: "Beach", tags: ["sand", "sea"] },
        { id: "k2", name: "City", tags: ["street"] },
    ];

    it("matches a flat AND include set that equals one kit", () => {
        const filter = setKitTagsModeOnFilter(
            emptyTagFilter(),
            ["sand", "sea"],
            "include",
        );
        expect(matchNearnessFilterToKitPreset(filter, presets)?.id).toBe("k1");
    });

    it("returns undefined for scopes, excludes, OR, or non-kit tag sets", () => {
        const kitFilter = setKitTagsModeOnFilter(
            emptyTagFilter(),
            ["sand", "sea"],
            "include",
        );
        expect(
            matchNearnessFilterToKitPreset(
                { ...kitFilter, favoritesScope: "favorites" },
                presets,
            ),
        ).toBeUndefined();

        const orFilter = {
            ...kitFilter,
            root: { ...kitFilter.root, op: "or" as const },
        };
        expect(matchNearnessFilterToKitPreset(orFilter, presets)).toBeUndefined();

        const other = setKitTagsModeOnFilter(
            emptyTagFilter(),
            ["sand"],
            "include",
        );
        expect(matchNearnessFilterToKitPreset(other, presets)).toBeUndefined();
    });
});

describe("stampTagsFromNearnessFilter", () => {
    const presets = [
        { id: "k1", name: "Beach", tags: ["sand", "sea"] },
        { id: "k2", name: "City", tags: ["street"] },
    ];

    it("returns kit mode for a matched kit filter", () => {
        const filter = nearnessFilterFromKitTags(["sand", "sea"]);
        expect(stampTagsFromNearnessFilter(filter, presets)).toEqual({
            tags: ["sand", "sea"],
            pickMode: "kit",
        });
    });

    it("returns tag mode for a non-kit include set", () => {
        const filter = setKitTagsModeOnFilter(
            emptyTagFilter(),
            ["sand"],
            "include",
        );
        expect(stampTagsFromNearnessFilter(filter, presets)).toEqual({
            tags: ["sand"],
            pickMode: "tag",
        });
    });

    it("returns undefined for an empty filter", () => {
        expect(
            stampTagsFromNearnessFilter(emptyTagFilter(), presets),
        ).toBeUndefined();
    });
});
