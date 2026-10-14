import {
    queryAlbumFilter,
    serializeTagFilter,
    type PersistedTagFilterNode,
    type QueryAlbum,
} from "@/lib/query-albums";
import type { TagFilterGroup } from "@/lib/tags";

const persistedNodeUsesTags = (
    node: PersistedTagFilterNode,
    tagNames: ReadonlySet<string>,
): boolean => {
    if (node.kind === "clause") {
        return tagNames.has(node.tag);
    }
    if (node.kind === "kit") {
        return node.tags.some((tag) => tagNames.has(tag));
    }
    return node.children.some(
        (child) => persistedNodeUsesTags(child, tagNames),
    );
};

/**
 * Apply a tag tree rewrite to a saved album's query. Albums whose query does
 * not reference any of {@link tagNames} are returned unchanged.
 *
 * [Note: album queries hold no node ids] The query is hydrated, rewritten, and
 * serialized again, so the persisted shape stays the same.
 *
 * @param rewriteRoot rewrites the hydrated filter root, e.g. with
 * `renameTagInTree` or `removeTagFromTree`.
 */
export const rewriteQueryAlbumTags = (
    album: QueryAlbum,
    tagNames: ReadonlySet<string>,
    rewriteRoot: (root: TagFilterGroup) => TagFilterGroup,
): QueryAlbum => {
    if (!persistedNodeUsesTags(album.query.root, tagNames)) {
        return album;
    }
    const filter = queryAlbumFilter(album);
    return {
        ...album,
        query: serializeTagFilter({
            ...filter,
            root: rewriteRoot(filter.root),
        }),
    };
};
