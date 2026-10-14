import { describe, expect, it } from "vitest";
import {
    createQueryAlbum,
    hydrateTagFilter,
    serializeTagFilter,
} from "@/lib/query-albums";
import {
    emptyTagFilter,
    newTagFilterNodeId,
    type TagFilterNode,
    type TagFilterSelection,
} from "@/lib/tag-filter";

describe("serializeTagFilter / hydrateTagFilter", () => {
    it("round-trips an empty filter", () => {
        const original = emptyTagFilter();
        const restored = hydrateTagFilter(serializeTagFilter(original));
        expect(restored.tagScope).toBe(original.tagScope);
        expect(restored.favoritesScope).toBe(original.favoritesScope);
        expect(restored.mediaScope).toBe(original.mediaScope);
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
            mediaScope: "photo",
            croppedScope: "cropped",
            rotatedScope: "rotated",
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
        expect(restored.mediaScope).toBe("photo");
        expect(restored.croppedScope).toBe("cropped");
        expect(restored.rotatedScope).toBe("rotated");
        expect(restored.root.children).toHaveLength(1);
        const group = restored.root.children[0];
        expect(group.kind).toBe("group");
        if (group.kind === "group") {
            expect(group.op).toBe("or");
            expect(group.children).toHaveLength(2);
        }
    });

    it("round-trips ONLY join", () => {
        const original: TagFilterSelection = {
            ...emptyTagFilter(),
            root: {
                kind: "group",
                id: newTagFilterNodeId(),
                op: "only",
                children: [
                    {
                        kind: "clause",
                        id: newTagFilterNodeId(),
                        tag: "selfie",
                        mode: "include",
                    },
                    {
                        kind: "clause",
                        id: newTagFilterNodeId(),
                        tag: "vietnam",
                        mode: "include",
                    },
                ],
            },
        };
        const restored = hydrateTagFilter(serializeTagFilter(original));
        expect(restored.root.op).toBe("only");
        expect(restored.root.children).toHaveLength(2);
    });

    it("round-trips kit units", () => {
        const original: TagFilterSelection = {
            ...emptyTagFilter(),
            root: {
                kind: "group",
                id: newTagFilterNodeId(),
                op: "or",
                children: [
                    {
                        kind: "kit",
                        id: newTagFilterNodeId(),
                        presetId: "k1",
                        name: "Beach",
                        tags: ["sand", "sea"],
                        mode: "exclude",
                    },
                    {
                        kind: "kit",
                        id: newTagFilterNodeId(),
                        presetId: "k2",
                        name: "City",
                        tags: ["street"],
                        mode: "exclude",
                    },
                ],
            },
        };
        const restored = hydrateTagFilter(serializeTagFilter(original));
        expect(restored.root.op).toBe("or");
        expect(restored.root.children).toHaveLength(2);
        const first = restored.root.children[0];
        expect(first.kind).toBe("kit");
        if (first.kind === "kit") {
            expect(first.presetId).toBe("k1");
            expect(first.name).toBe("Beach");
            expect(first.tags).toEqual(["sand", "sea"]);
            expect(first.mode).toBe("exclude");
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

    it("serializes to the same persisted shape as the field-by-field serializer", () => {
        const legacySerializeNode = (node: TagFilterNode): unknown => {
            if (node.kind === "clause") {
                return { kind: "clause", tag: node.tag, mode: node.mode };
            }
            if (node.kind === "kit") {
                return {
                    kind: "kit",
                    presetId: node.presetId,
                    name: node.name,
                    tags: [...node.tags],
                    mode: node.mode,
                };
            }
            return {
                kind: "group",
                op: node.op,
                children: node.children.map(legacySerializeNode),
            };
        };
        const filter: TagFilterSelection = {
            tagScope: "tagged",
            favoritesScope: "not-favorites",
            mediaScope: "video",
            croppedScope: "not-cropped",
            rotatedScope: "rotated",
            root: {
                kind: "group",
                id: newTagFilterNodeId(),
                op: "and",
                children: [
                    {
                        kind: "clause",
                        id: newTagFilterNodeId(),
                        tag: "beach",
                        mode: "exclude",
                    },
                    {
                        kind: "group",
                        id: newTagFilterNodeId(),
                        op: "only",
                        children: [
                            {
                                kind: "kit",
                                id: newTagFilterNodeId(),
                                presetId: "k1",
                                name: "Beach",
                                tags: ["sand", "sea"],
                                mode: "include",
                            },
                        ],
                    },
                ],
            },
        };
        const legacy = {
            tagScope: filter.tagScope,
            favoritesScope: filter.favoritesScope,
            mediaScope: filter.mediaScope,
            croppedScope: filter.croppedScope,
            rotatedScope: filter.rotatedScope,
            root: legacySerializeNode(filter.root),
        };
        expect(JSON.stringify(serializeTagFilter(filter))).toBe(
            JSON.stringify(legacy),
        );
    });
});
