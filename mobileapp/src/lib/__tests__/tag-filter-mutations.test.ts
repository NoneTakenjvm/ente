import { describe, expect, it } from "vitest";
import {
    findKitModeInGroup,
    kitIsIncluded,
    setClauseInGroupOnFilter,
    setClauseModeOnFilter,
    setKitModeOnFilter,
    setTagFilterModeOnFilter,
    setTagFilterScope,
} from "@/lib/tag-filter-mutations";
import {
    createEmptyTagFilterRoot,
    emptyTagFilter,
    findClauseInGroup,
    isFlatTagFilterRoot,
    isTagFilterKit,
    newTagFilterNodeId,
    type TagFilterClauseNode,
    type TagFilterGroup,
} from "@/lib/tags";

const includeClause = (tag: string): TagFilterClauseNode => ({
    kind: "clause",
    id: newTagFilterNodeId(),
    tag,
    mode: "include",
});

const andRoot = (...children: TagFilterGroup["children"]): TagFilterGroup => ({
    kind: "group",
    id: newTagFilterNodeId(),
    op: "and",
    children,
});

const presenceOff = new Map([["junk", false]]);

describe("tag-filter-mutations", () => {
    it("isFlatTagFilterRoot is true for flat and empty roots", () => {
        expect(isFlatTagFilterRoot(createEmptyTagFilterRoot())).toBe(true);
        expect(
            isFlatTagFilterRoot(andRoot(includeClause("a"), includeClause("b"))),
        ).toBe(true);
    });

    it("isFlatTagFilterRoot is true for kit leaves", () => {
        let filter = emptyTagFilter();
        filter = setKitModeOnFilter(
            filter,
            { presetId: "k1", name: "Beach", tags: ["a", "b"] },
            "include",
        );
        expect(isFlatTagFilterRoot(filter.root)).toBe(true);
        expect(isTagFilterKit(filter.root.children[0])).toBe(true);
    });

    it("isFlatTagFilterRoot is false when nested groups exist", () => {
        const nested = andRoot(
            andRoot(includeClause("a"), includeClause("b")),
            includeClause("c"),
        );
        expect(isFlatTagFilterRoot(nested)).toBe(false);
    });

    it("setClauseInGroupOnFilter adds one clause per group", () => {
        let filter = emptyTagFilter();
        filter = setClauseInGroupOnFilter(filter, filter.root.id, "a", "include");
        filter = setClauseInGroupOnFilter(filter, filter.root.id, "a", "exclude");
        expect(findClauseInGroup(filter.root, "a")?.mode).toBe("exclude");
        expect(filter.root.children).toHaveLength(1);
    });

    it("setClauseInGroupOnFilter allows the same tag in sibling groups", () => {
        let filter = emptyTagFilter();
        const groupA = andRoot(includeClause("a"));
        const groupB = andRoot(includeClause("b"));
        filter = {
            ...filter,
            root: {
                ...filter.root,
                op: "or",
                children: [groupA, groupB],
            },
        };
        filter = setClauseInGroupOnFilter(filter, groupA.id, "b", "exclude");
        filter = setClauseInGroupOnFilter(filter, groupB.id, "b", "include");
        const updatedA = filter.root.children[0] as TagFilterGroup;
        const updatedB = filter.root.children[1] as TagFilterGroup;
        expect(findClauseInGroup(updatedA, "b")?.mode).toBe("exclude");
        expect(findClauseInGroup(updatedB, "b")?.mode).toBe("include");
    });

    it("setClauseModeOnFilter updates one clause by id", () => {
        const clause = includeClause("selfie");
        let filter = {
            ...emptyTagFilter(),
            root: andRoot(clause),
        };
        filter = setClauseModeOnFilter(filter, clause.id, "exclude");
        const updated = filter.root.children[0] as TagFilterClauseNode;
        expect(updated.mode).toBe("exclude");
    });

    it("setKitModeOnFilter adds one kit unit (not expanded tags)", () => {
        let filter = emptyTagFilter();
        filter = setKitModeOnFilter(
            filter,
            { presetId: "k1", name: "Beach", tags: ["a", "b"] },
            "include",
        );
        expect(kitIsIncluded(filter.root, "k1")).toBe(true);
        expect(filter.root.children).toHaveLength(1);
        expect(findKitModeInGroup(filter.root, "k1")).toBe("include");
        filter = setKitModeOnFilter(
            filter,
            { presetId: "k1", name: "Beach", tags: ["a", "b"] },
            "exclude",
        );
        expect(findKitModeInGroup(filter.root, "k1")).toBe("exclude");
        filter = setKitModeOnFilter(
            filter,
            { presetId: "k1", name: "Beach", tags: ["a", "b"] },
            null,
        );
        expect(findKitModeInGroup(filter.root, "k1")).toBeNull();
        expect(filter.root.children).toHaveLength(0);
    });

    it("setTagFilterModeOnFilter clears tagged scope when adding include", () => {
        let filter = {
            ...emptyTagFilter(),
            tagScope: "tagged" as const,
        };
        filter = setTagFilterModeOnFilter(filter, "selfie", "include");
        expect(filter.tagScope).toBe("all");
        expect(findClauseInGroup(filter.root, "selfie")?.mode).toBe("include");
    });

    it("setTagFilterModeOnFilter keeps tagged scope when adding exclude", () => {
        let filter = {
            ...emptyTagFilter(),
            tagScope: "tagged" as const,
        };
        filter = setTagFilterModeOnFilter(filter, "vietnam", "exclude");
        expect(filter.tagScope).toBe("tagged");
        expect(findClauseInGroup(filter.root, "vietnam")?.mode).toBe("exclude");
    });

    it("setClauseModeOnFilter clears tagged scope when switching to include", () => {
        const clause = includeClause("selfie");
        let filter = {
            ...emptyTagFilter(),
            tagScope: "tagged" as const,
            root: andRoot({ ...clause, mode: "exclude" }),
        };
        filter = setClauseModeOnFilter(filter, clause.id, "include");
        expect(filter.tagScope).toBe("all");
        const updated = filter.root.children[0] as TagFilterClauseNode;
        expect(updated.mode).toBe("include");
    });

    it("presence-off include keeps tagged and untagged scopes", () => {
        let tagged = {
            ...emptyTagFilter(),
            tagScope: "tagged" as const,
        };
        tagged = setTagFilterModeOnFilter(
            tagged,
            "junk",
            "include",
            presenceOff,
        );
        expect(tagged.tagScope).toBe("tagged");
        expect(findClauseInGroup(tagged.root, "junk")?.mode).toBe("include");

        let untagged = {
            ...emptyTagFilter(),
            tagScope: "untagged" as const,
        };
        untagged = setTagFilterModeOnFilter(
            untagged,
            "junk",
            "include",
            presenceOff,
        );
        expect(untagged.tagScope).toBe("untagged");
        expect(findClauseInGroup(untagged.root, "junk")?.mode).toBe("include");
    });

    it("setTagFilterScope to untagged keeps presence-off clauses only", () => {
        let filter = emptyTagFilter();
        filter = setTagFilterModeOnFilter(filter, "selfie", "include");
        filter = setTagFilterModeOnFilter(
            filter,
            "junk",
            "include",
            presenceOff,
        );
        filter = setTagFilterScope(filter, "untagged", presenceOff);
        expect(filter.tagScope).toBe("untagged");
        expect(findClauseInGroup(filter.root, "junk")?.mode).toBe("include");
        expect(findClauseInGroup(filter.root, "selfie")).toBeNull();
    });

    it("setTagFilterScope to untagged clears all when no presence map", () => {
        let filter = emptyTagFilter();
        filter = setTagFilterModeOnFilter(filter, "selfie", "include");
        filter = setTagFilterScope(filter, "untagged");
        expect(filter.tagScope).toBe("untagged");
        expect(filter.root.children).toHaveLength(0);
    });
});
