import {
    emptyTagFilter,
    isTagFilterGroup,
    newTagFilterNodeId,
    type TagFilterClauseNode,
    type TagFilterGroup,
    type TagFilterKitNode,
    type TagFilterNode,
    type TagFilterSelection,
} from "@/lib/tag-filter";

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

/** A filter node as stored: same shape minus the ephemeral `id`. */
type Persisted<T> = T extends unknown ? Omit<T, "id"> : never;

export type PersistedTagFilterGroup = Persisted<Omit<TagFilterGroup, "children">> & {
    children: PersistedTagFilterNode[];
};

export type PersistedTagFilterNode =
    Persisted<TagFilterClauseNode> |
    Persisted<TagFilterKitNode> |
    PersistedTagFilterGroup;

export type PersistedTagFilterSelection = Omit<TagFilterSelection, "root"> & {
    root: PersistedTagFilterGroup;
};

const withoutId = <T extends { id: string }>({
    id: _id,
    ...rest
}: T): Persisted<T> => rest as Persisted<T>;

const serializeNode = (node: TagFilterNode): PersistedTagFilterNode =>
    isTagFilterGroup(node) ?
        { ...withoutId(node), children: node.children.map(serializeNode) } :
        withoutId(node);

/**
 * Strip ephemeral node ids for organizer config persistence.
 */
export const serializeTagFilter = (
    filter: TagFilterSelection,
): PersistedTagFilterSelection => ({
    ...filter,
    root: serializeNode(filter.root) as PersistedTagFilterGroup,
});

const hydrateNode = (node: PersistedTagFilterNode): TagFilterNode =>
    node.kind === "group" ?
        {
            ...node,
            id: newTagFilterNodeId(),
            children: node.children.map(hydrateNode),
        } :
        { ...node, id: newTagFilterNodeId() };

/**
 * Restore a persisted query into an in-memory filter tree with fresh node ids.
 */
export const hydrateTagFilter = (
    persisted: PersistedTagFilterSelection,
): TagFilterSelection => ({
    ...persisted,
    mediaScope: persisted.mediaScope ?? "all",
    croppedScope: persisted.croppedScope ?? "all",
    rotatedScope: persisted.rotatedScope ?? "all",
    root: hydrateNode(persisted.root) as TagFilterGroup,
});

const newQueryAlbumId = (): string =>
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
