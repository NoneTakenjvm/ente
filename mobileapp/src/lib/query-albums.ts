import {
    emptyTagFilter,
    isTagFilterClause,
    newTagFilterNodeId,
    type TagFilterClauseNode,
    type TagFilterGroup,
    type TagFilterJoin,
    type TagFilterMode,
    type TagFilterNode,
    type TagFilterSelection,
    type TagScope,
    type FavoritesScope,
    type MediaScope,
} from "@/lib/tags";

/** A saved smart album backed by a tag query. */
export interface QueryAlbum {
    id: string;
    name: string;
    query: PersistedTagFilterSelection;
    /** Ente file id for a custom list thumbnail; omit for newest match. */
    coverFileId?: number;
}

export interface PersistedQueryAlbums {
    albums: QueryAlbum[];
}

export type PersistedTagFilterClause = {
    kind: "clause";
    tag: string;
    mode: TagFilterMode;
};

export type PersistedTagFilterGroup = {
    kind: "group";
    op: TagFilterJoin;
    children: PersistedTagFilterNode[];
};

export type PersistedTagFilterNode =
    PersistedTagFilterClause |
    PersistedTagFilterGroup;

export interface PersistedTagFilterSelection {
    tagScope: TagScope;
    favoritesScope: FavoritesScope;
    mediaScope: MediaScope;
    root: PersistedTagFilterGroup;
}

const serializeNode = (node: TagFilterNode): PersistedTagFilterNode => {
    if (isTagFilterClause(node)) {
        return { kind: "clause", tag: node.tag, mode: node.mode };
    }
    return {
        kind: "group",
        op: node.op,
        children: node.children.map(serializeNode),
    };
};

/**
 * Strip ephemeral node ids for organizer config persistence.
 */
export const serializeTagFilter = (
    filter: TagFilterSelection,
): PersistedTagFilterSelection => ({
    tagScope: filter.tagScope,
    favoritesScope: filter.favoritesScope,
    mediaScope: filter.mediaScope,
    root: serializeNode(filter.root) as PersistedTagFilterGroup,
});

const hydrateClause = (
    clause: PersistedTagFilterClause,
): TagFilterClauseNode => ({
    kind: "clause",
    id: newTagFilterNodeId(),
    tag: clause.tag,
    mode: clause.mode,
});

const hydrateNode = (node: PersistedTagFilterNode): TagFilterNode => {
    if (node.kind === "clause") {
        return hydrateClause(node);
    }
    return {
        kind: "group",
        id: newTagFilterNodeId(),
        op: node.op,
        children: node.children.map(hydrateNode),
    };
};

/**
 * Restore a persisted query into an in-memory filter tree with fresh node ids.
 */
export const hydrateTagFilter = (
    persisted: PersistedTagFilterSelection,
): TagFilterSelection => ({
    tagScope: persisted.tagScope,
    favoritesScope: persisted.favoritesScope,
    mediaScope: persisted.mediaScope ?? "all",
    root: hydrateNode(persisted.root) as TagFilterGroup,
});

export const emptyPersistedTagFilter = (): PersistedTagFilterSelection =>
    serializeTagFilter(emptyTagFilter());

export const newQueryAlbumId = (): string =>
    `album-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const createQueryAlbum = (
    name: string,
    query: TagFilterSelection = emptyTagFilter(),
): QueryAlbum => ({
    id: newQueryAlbumId(),
    name: name.trim(),
    query: serializeTagFilter(query),
});

export const queryAlbumFilter = (album: QueryAlbum): TagFilterSelection =>
    hydrateTagFilter(album.query);

export const emptyPersistedQueryAlbums = (): PersistedQueryAlbums => ({
    albums: [],
});
