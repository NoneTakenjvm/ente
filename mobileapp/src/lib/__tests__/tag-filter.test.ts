import { describe, expect, it } from "vitest";
import {
    countTagFilterClauses,
    createEmptyTagFilterRoot,
    describeTagFilter,
    describeTagFilterType,
    emptyTagFilter,
    filterFilesByTags,
    isFlatTagFilterRoot,
    type TagFilterMode,
    type TagFilterSelection,
    type TagFilterTypeNode,
} from "@/lib/tag-filter";
import {
    setClauseInGroupOnFilter,
    setTagFilterModeOnFilter,
    setTypeModeOnFilter,
} from "@/lib/tag-filter-mutations";
import { DEFAULT_TAG_TYPE } from "@/lib/tag-types";
import { fileWithTags } from "@/test-utils/fixtures";

const SYSTEM_TAG = "compressed";

const files = [
    fileWithTags(1, ["beach", "sunset"]),
    fileWithTags(2, ["vietnam"]),
    fileWithTags(3, ["selfie"]),
    fileWithTags(4, []),
    fileWithTags(5, []),
    fileWithTags(6, ["beach"]),
];

/** Id 5 carries only a system tag, which must never count toward a type. */
const fileIdsByTag = new Map<string, Set<number>>([
    ["beach", new Set([1, 6])],
    ["sunset", new Set([1])],
    ["vietnam", new Set([2])],
    ["selfie", new Set([3])],
    [SYSTEM_TAG, new Set([5])],
]);

const tagTypeByName = new Map<string, string>([
    ["beach", "place"],
    ["vietnam", "place"],
    [SYSTEM_TAG, "place"],
]);

const matchIds = (filter: TagFilterSelection): number[] =>
    filterFilesByTags(files, filter, fileIdsByTag, { tagTypeByName }).map(
        (file) => file.id,
    );

const typeFilter = (
    type: string,
    mode: TagFilterMode,
): TagFilterSelection => setTypeModeOnFilter(emptyTagFilter(), type, mode);

describe("type filter evaluation", () => {
    it("include type matches files with any tag of the type", () => {
        expect(matchIds(typeFilter("place", "include"))).toEqual([1, 2, 6]);
    });

    it("exclude type keeps files with no tag of the type", () => {
        expect(matchIds(typeFilter("place", "exclude"))).toEqual([3, 4, 5]);
    });

    it("ignores system tags when matching a type", () => {
        expect(matchIds(typeFilter("place", "include"))).not.toContain(5);
    });

    it("tags without an explicit type resolve to the default type", () => {
        expect(matchIds(typeFilter(DEFAULT_TAG_TYPE, "include"))).toEqual([1, 3]);
    });

    it("type units combine with other clauses in an OR group", () => {
        let filter: TagFilterSelection = {
            ...emptyTagFilter(),
            root: { ...createEmptyTagFilterRoot(), op: "or" },
        };
        filter = setTypeModeOnFilter(filter, "place", "include");
        filter = setClauseInGroupOnFilter(
            filter,
            filter.root.id,
            "selfie",
            "include",
        );
        expect(matchIds(filter)).toEqual([1, 2, 3, 6]);
    });

    it("type units narrow the exact tag set inside an ONLY group", () => {
        let filter: TagFilterSelection = {
            ...emptyTagFilter(),
            root: { ...createEmptyTagFilterRoot(), op: "only" },
        };
        filter = setTagFilterModeOnFilter(filter, "beach", "include");
        filter = setTypeModeOnFilter(filter, "place", "include");
        expect(matchIds(filter)).toEqual([6]);
        filter = setTypeModeOnFilter(filter, "place", "exclude");
        expect(matchIds(filter)).toEqual([]);
    });
});

describe("type filter description", () => {
    it("describes include and exclude type units", () => {
        expect(describeTagFilter(typeFilter("place", "include"))).toBe("any place");
        expect(describeTagFilter(typeFilter("place", "exclude"))).toBe(
            "not any place",
        );
    });

    it("labels a type unit for the query builder", () => {
        const filter = typeFilter("place", "exclude");
        const node = filter.root.children[0] as TagFilterTypeNode;
        expect(describeTagFilterType(node)).toBe("Has no place tag");
    });

    it("counts a type unit as one clause on a flat root", () => {
        const filter = typeFilter("place", "include");
        expect(countTagFilterClauses(filter.root)).toBe(1);
        expect(isFlatTagFilterRoot(filter.root)).toBe(true);
    });
});
