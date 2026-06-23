import { describe, expect, it } from "vitest";
import {
    createQueryAlbum,
    hydrateTagFilter,
    serializeTagFilter,
} from "@/lib/query-albums";
import {
    emptyTagFilter,
    newTagFilterNodeId,
    type TagFilterSelection,
} from "@/lib/tags";

describe("serializeTagFilter / hydrateTagFilter", () => {
    it("round-trips an empty filter", () => {
        const original = emptyTagFilter();
        const restored = hydrateTagFilter(serializeTagFilter(original));
        expect(restored.tagScope).toBe(original.tagScope);
        expect(restored.favoritesScope).toBe(original.favoritesScope);
        expect(restored.root.op).toBe(original.root.op);
        expect(restored.root.children).toHaveLength(0);
    });

    it("round-trips nested AND/OR clauses", () => {
        const clauseA = {
            kind: "clause" as const,
            id: newTagFilterNodeId(),
            tag: "beach",
            mode: "include" as const,
        };
        const clauseB = {
            kind: "clause" as const,
            id: newTagFilterNodeId(),
            tag: "sunset",
            mode: "exclude" as const,
        };
        const innerGroup = {
            kind: "group" as const,
            id: newTagFilterNodeId(),
            op: "or" as const,
            children: [clauseA, clauseB],
        };
        const original: TagFilterSelection = {
            tagScope: "tagged",
            favoritesScope: "favorites",
            root: {
                kind: "group",
                id: newTagFilterNodeId(),
                op: "and",
                children: [innerGroup],
            },
        };

        const restored = hydrateTagFilter(serializeTagFilter(original));
        expect(restored.tagScope).toBe("tagged");
        expect(restored.favoritesScope).toBe("favorites");
        expect(restored.root.children).toHaveLength(1);
        const group = restored.root.children[0];
        expect(group.kind).toBe("group");
        if (group.kind === "group") {
            expect(group.op).toBe("or");
            expect(group.children).toHaveLength(2);
        }
    });
});

describe("createQueryAlbum", () => {
    it("stores a serialized query", () => {
        const album = createQueryAlbum("Summer", emptyTagFilter());
        expect(album.name).toBe("Summer");
        expect(album.query.tagScope).toBe("all");
        expect(album.id).toMatch(/^album-/);
    });
});
