import { describe, expect, it } from "vitest";
import { rewriteQueryAlbumTags } from "@/lib/album-tag-rewrite";
import { removeTagFromTree, renameTagInTree } from "@/lib/tag-filter-mutations";
import { createQueryAlbum } from "@/lib/query-albums";
import {
    emptyTagFilter,
    newTagFilterNodeId,
    type TagFilterKitNode,
} from "@/lib/tags";
import { andRoot, includeClause } from "@/test-utils/fixtures";

const kitNode = (tags: string[]): TagFilterKitNode => ({
    kind: "kit",
    id: newTagFilterNodeId(),
    presetId: "k1",
    name: "Beach",
    tags,
    mode: "include",
});

describe("rewriteQueryAlbumTags", () => {
    it("returns the album unchanged when no tag matches", () => {
        const album = createQueryAlbum("Summer", {
            ...emptyTagFilter(),
            root: andRoot(includeClause("a")),
        });
        const next = rewriteQueryAlbumTags(
            album,
            new Set(["zzz"]),
            (root) => renameTagInTree(root, "zzz", "y"),
        );
        expect(next).toBe(album);
    });

    it("renames clause and kit tags in the persisted query", () => {
        const album = createQueryAlbum("Summer", {
            ...emptyTagFilter(),
            root: andRoot(includeClause("a"), kitNode(["a", "b"])),
        });
        const next = rewriteQueryAlbumTags(
            album,
            new Set(["a"]),
            (root) => renameTagInTree(root, "a", "z"),
        );
        expect(next.id).toBe(album.id);
        expect(next.name).toBe("Summer");
        expect(next.query.root.children).toEqual([
            { kind: "clause", tag: "z", mode: "include" },
            {
                kind: "kit",
                presetId: "k1",
                name: "Beach",
                tags: ["z", "b"],
                mode: "include",
            },
        ]);
    });

    it("drops a tag and the nested group it empties", () => {
        const album = createQueryAlbum("Summer", {
            ...emptyTagFilter(),
            root: andRoot(andRoot(includeClause("a")), includeClause("b")),
        });
        const next = rewriteQueryAlbumTags(
            album,
            new Set(["a"]),
            (root) => removeTagFromTree(root, "a"),
        );
        expect(next.query.root.children).toEqual([
            { kind: "clause", tag: "b", mode: "include" },
        ]);
    });
});
