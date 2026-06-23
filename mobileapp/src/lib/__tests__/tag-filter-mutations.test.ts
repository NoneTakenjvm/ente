import { describe, expect, it } from "vitest";
import {
    setClauseInGroupOnFilter,
    setClauseModeOnFilter,
} from "@/lib/tag-filter-mutations";
import {
    createEmptyTagFilterRoot,
    emptyTagFilter,
    findClauseInGroup,
    isFlatTagFilterRoot,
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

describe("tag-filter-mutations", () => {
    it("isFlatTagFilterRoot is true for flat and empty roots", () => {
        expect(isFlatTagFilterRoot(createEmptyTagFilterRoot())).toBe(true);
        expect(
            isFlatTagFilterRoot(andRoot(includeClause("a"), includeClause("b"))),
        ).toBe(true);
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
});
