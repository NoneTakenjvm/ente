import type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
import type { EnteFile } from "ente-media/file";
import { getPublicMetadata } from "@/core/metadata";
import type { PersistedTagIndex } from "@/db/kv";

export interface OrganizerTagMetadata {
    tags?: string[];
    updatedAt?: number;
}

export const SYSTEM_TAGS = new Set(["compressed", "rotated", "cropped"]);

/** Gallery filter pseudo-tag for files with no user tags. */
export const UNTAGGED_FILTER = "untagged";

/** Gallery filter for files that have at least one user tag. */
export const TAGGED_FILTER = "tagged";

export const FAVORITES_FILTER = "favourites";

/** Gallery filter for files that are not favourited. */
export const NOT_FAVORITES_FILTER = "not-favourites";

export type TagFilterMode = "include" | "exclude";

export type TagFilterJoin = "and" | "or";

export type TagScope = "all" | "tagged" | "untagged";

export type FavoritesScope = "all" | "favorites" | "not-favorites";

export interface TagFilterClauseNode {
    kind: "clause";
    id: string;
    tag: string;
    mode: TagFilterMode;
}

export interface TagFilterGroup {
    kind: "group";
    id: string;
    op: TagFilterJoin;
    children: TagFilterNode[];
}

export type TagFilterNode = TagFilterClauseNode | TagFilterGroup;

export interface TagFilterSelection {
    tagScope: TagScope;
    favoritesScope: FavoritesScope;
    root: TagFilterGroup;
}

export interface TagFilterOptions {
    favoriteFileIds?: Set<number>;
}

let tagFilterNodeCounter = 0;

/** Create a stable id for a new filter tree node. */
export const newTagFilterNodeId = (): string => {
    tagFilterNodeCounter += 1;
    return `tf-${tagFilterNodeCounter}`;
};

/** Create an empty root group for a new filter selection. */
export const createEmptyTagFilterRoot = (): TagFilterGroup => ({
    kind: "group",
    id: newTagFilterNodeId(),
    op: "and",
    children: [],
});

export const emptyTagFilter = (): TagFilterSelection => ({
    tagScope: "all",
    favoritesScope: "all",
    root: createEmptyTagFilterRoot(),
});

export const isTagFilterGroup = (node: TagFilterNode): node is TagFilterGroup =>
    node.kind === "group";

export const isTagFilterClause = (
    node: TagFilterNode,
): node is TagFilterClauseNode => node.kind === "clause";

/** Count clause leaves in the filter tree. */
export const countTagFilterClauses = (root: TagFilterGroup): number => {
    let count = 0;
    const walk = (node: TagFilterNode): void => {
        if (isTagFilterClause(node)) {
            count += 1;
            return;
        }
        for (const child of node.children) {
            walk(child);
        }
    };
    for (const child of root.children) {
        walk(child);
    }
    return count;
};

/** Find the include/exclude mode for a tag in the root group (shallow clause lookup). */
export const findClauseModeForTag = (
    root: TagFilterGroup,
    tag: string,
): TagFilterMode | null => {
    for (const child of root.children) {
        if (isTagFilterClause(child) && child.tag === tag) {
            return child.mode;
        }
    }
    return null;
};

/** True when every root child is a clause (no nested groups). */
export const isFlatTagFilterRoot = (root: TagFilterGroup): boolean =>
    root.children.every((child) => isTagFilterClause(child));

/** Find a direct-child clause for a tag within one group. */
export const findClauseInGroup = (
    group: TagFilterGroup,
    tag: string,
): TagFilterClauseNode | null => {
    for (const child of group.children) {
        if (isTagFilterClause(child) && child.tag === tag) {
            return child;
        }
    }
    return null;
};

/** Find a group node anywhere in the filter tree by id. */
export const findTagFilterGroupById = (
    root: TagFilterGroup,
    groupId: string,
): TagFilterGroup | null => {
    if (root.id === groupId) {
        return root;
    }
    for (const child of root.children) {
        if (isTagFilterGroup(child)) {
            const found = findTagFilterGroupById(child, groupId);
            if (found) {
                return found;
            }
        }
    }
    return null;
};

/** Shown when the quick tag dropdown is disabled for grouped filters. */
export const GROUPED_TAG_FILTER_DROPDOWN_HINT =
    "Grouped filters can only be edited in the query builder.";

export const isTagFilterActive = (filter: TagFilterSelection): boolean =>
    filter.tagScope !== "all" ||
    filter.favoritesScope !== "all" ||
    countTagFilterClauses(filter.root) > 0;

const describeClauseNode = (clause: TagFilterClauseNode): string =>
    clause.mode === "exclude" ? `not ${clause.tag}` : clause.tag;

const describeGroupNode = (group: TagFilterGroup): string => {
    if (group.children.length === 0) {
        return "";
    }
    const parts = group.children.map((child) => {
        if (isTagFilterClause(child)) {
            return describeClauseNode(child);
        }
        const inner = describeGroupNode(child);
        return inner ? `(${inner})` : "";
    }).filter((part) => part.length > 0);
    return parts.join(` ${group.op.toUpperCase()} `);
};

/**
 * Human-readable summary of the active filter (e.g. "tagged · favourites · (selfie AND not vietnam)").
 */
export const describeTagFilter = (filter: TagFilterSelection): string => {
    const parts: string[] = [];
    if (filter.tagScope === "untagged") {
        parts.push(UNTAGGED_FILTER);
    } else if (filter.tagScope === "tagged") {
        parts.push(TAGGED_FILTER);
    }
    if (filter.favoritesScope === "favorites") {
        parts.push(FAVORITES_FILTER);
    } else if (filter.favoritesScope === "not-favorites") {
        parts.push(NOT_FAVORITES_FILTER);
    }
    const expr = describeGroupNode(filter.root);
    if (expr) {
        parts.push(expr);
    }
    return parts.join(" · ");
};

/** Instruction label for one tag clause in the query builder. */
export const describeTagFilterClause = (clause: TagFilterClauseNode): string =>
    clause.mode === "exclude" ? `Not ${clause.tag}` : `Has ${clause.tag}`;

/**
 * Return true when the tag is reserved for internal organizer workflows.
 */
export const isSystemTag = (tag: string): boolean => SYSTEM_TAGS.has(tag);

/**
 * Return true when the name is reserved and must not be assigned to files.
 */
export const isReservedTag = (tag: string): boolean =>
    isSystemTag(tag) ||
    tag === UNTAGGED_FILTER ||
    tag === TAGGED_FILTER ||
    tag === FAVORITES_FILTER ||
    tag === NOT_FAVORITES_FILTER;

/**
 * Read organizer tags from public magic metadata (`_organizer_v1.tags`).
 */
export const extractTags = (file: EnteFile): string[] => {
    const data = getPublicMetadata(file) as FilePublicMagicMetadataData &
        { _organizer_v1?: OrganizerTagMetadata };
    const tags = data._organizer_v1?.tags;
    if (!tags?.length) {
        return [];
    }
    return tags.filter((tag) => typeof tag === "string" && tag.length > 0);
};

/**
 * User-visible organizer tags (excludes internal system tags).
 */
export const extractUserTags = (file: EnteFile): string[] =>
    extractTags(file).filter((tag) => !isSystemTag(tag));

/**
 * Build a tag index from decrypted files.
 */
export const buildTagIndex = (files: EnteFile[]): PersistedTagIndex => {
    const fileIdsByTag: Record<string, number[]> = {};
    const tagSet = new Set<string>();

    for (const file of files) {
        for (const tag of extractUserTags(file)) {
            tagSet.add(tag);
            const list = fileIdsByTag[tag] ?? [];
            list.push(file.id);
            fileIdsByTag[tag] = list;
        }
    }

    return {
        tags: [...tagSet].sort(),
        fileIdsByTag,
    };
};

export const tagIndexToMaps = (
    index: PersistedTagIndex,
): {
    tags: string[];
    fileIdsByTag: Map<string, Set<number>>;
} => {
    const fileIdsByTag = new Map<string, Set<number>>();
    for (const tag of index.tags) {
        fileIdsByTag.set(tag, new Set(index.fileIdsByTag[tag] ?? []));
    }
    return { tags: index.tags, fileIdsByTag };
};

const intersectIds = (
    left: Set<number>,
    right: Set<number>,
): Set<number> => new Set([...left].filter((id) => right.has(id)));

const allFileIds = (files: EnteFile[]): Set<number> =>
    new Set(files.map((file) => file.id));

const untaggedIdsInCandidates = (
    candidateFileIds: Set<number>,
    fileIdsByTag: Map<string, Set<number>>,
): Set<number> => {
    const taggedIds = taggedIdsInCandidates(
        candidateFileIds,
        fileIdsByTag,
    );
    return new Set(
        [...candidateFileIds].filter((id) => !taggedIds.has(id)),
    );
};

const taggedIdsInCandidates = (
    candidateFileIds: Set<number>,
    fileIdsByTag: Map<string, Set<number>>,
): Set<number> => {
    const taggedIds = new Set<number>();
    for (const ids of fileIdsByTag.values()) {
        for (const id of ids) {
            if (candidateFileIds.has(id)) {
                taggedIds.add(id);
            }
        }
    }
    return taggedIds;
};

const subtractIds = (
    universe: Set<number>,
    remove: Set<number>,
): Set<number> => new Set([...universe].filter((id) => !remove.has(id)));

const unionIds = (
    left: Set<number>,
    right: Set<number>,
): Set<number> => new Set([...left, ...right]);

const tagIdsInCandidates = (
    tag: string,
    candidateIds: Set<number>,
    files: EnteFile[],
    fileIdsByTag: Map<string, Set<number>>,
): Set<number> => {
    const idsForTag = fileIdsByTag.get(tag) ?? new Set<number>();
    const scoped = new Set(
        [...idsForTag].filter((id) => candidateIds.has(id)),
    );
    if (tag === UNTAGGED_FILTER) {
        return untaggedIdsInCandidates(candidateIds, fileIdsByTag);
    }
    return scoped;
};

const evaluateClauseNode = (
    clause: TagFilterClauseNode,
    candidateIds: Set<number>,
    files: EnteFile[],
    fileIdsByTag: Map<string, Set<number>>,
): Set<number> => {
    const tagIds = tagIdsInCandidates(
        clause.tag,
        candidateIds,
        files,
        fileIdsByTag,
    );
    if (clause.mode === "include") {
        return tagIds;
    }
    return subtractIds(candidateIds, tagIds);
};

/**
 * Evaluate a tag filter expression tree against a candidate file id set.
 */
export const evaluateTagFilterNode = (
    node: TagFilterNode,
    candidateIds: Set<number>,
    files: EnteFile[],
    fileIdsByTag: Map<string, Set<number>>,
): Set<number> => {
    if (isTagFilterClause(node)) {
        return evaluateClauseNode(node, candidateIds, files, fileIdsByTag);
    }

    if (node.children.length === 0) {
        return candidateIds;
    }

    const childSets = node.children.map((child) => evaluateTagFilterNode(
        child,
        candidateIds,
        files,
        fileIdsByTag,
    ));

    if (node.op === "or") {
        return childSets.reduce((acc, set) => unionIds(acc, set), new Set<number>());
    }
    return childSets.reduce(
        (acc, set) => intersectIds(acc, set),
        childSets[0],
    );
};

const applyTagScope = (
    tagScope: TagScope,
    candidateIds: Set<number>,
    fileIdsByTag: Map<string, Set<number>>,
): Set<number> | undefined => {
    if (tagScope === "untagged") {
        return untaggedIdsInCandidates(candidateIds, fileIdsByTag);
    }
    if (tagScope === "tagged") {
        return taggedIdsInCandidates(candidateIds, fileIdsByTag);
    }
    return undefined;
};

const applyFavoritesScope = (
    matchingIds: Set<number>,
    favoriteFileIds: Set<number> | undefined,
    favoritesScope: FavoritesScope,
): Set<number> => {
    if (favoritesScope === "all" || !favoriteFileIds) {
        return matchingIds;
    }
    if (favoritesScope === "favorites") {
        return intersectIds(matchingIds, favoriteFileIds);
    }
    const notFavorites = new Set<number>();
    for (const id of matchingIds) {
        if (!favoriteFileIds.has(id)) {
            notFavorites.add(id);
        }
    }
    return notFavorites;
};

const resolveMatchingIds = (
    files: EnteFile[],
    candidateIds: Set<number>,
    filter: TagFilterSelection,
    fileIdsByTag: Map<string, Set<number>>,
    favoriteFileIds: Set<number> | undefined,
): Set<number> => {
    let matchingIds = new Set(candidateIds);

    const scopeIds = applyTagScope(
        filter.tagScope,
        matchingIds,
        fileIdsByTag,
    );
    if (scopeIds !== undefined) {
        matchingIds = scopeIds;
    }

    matchingIds = applyFavoritesScope(
        matchingIds,
        favoriteFileIds,
        filter.favoritesScope,
    );

    if (matchingIds.size === 0) {
        return matchingIds;
    }

    const exprIds = evaluateTagFilterNode(
        filter.root,
        matchingIds,
        files,
        fileIdsByTag,
    );

    if (countTagFilterClauses(filter.root) === 0) {
        return matchingIds;
    }

    return intersectIds(matchingIds, exprIds);
};

/**
 * Keep files matching the tag filter selection.
 */
export const filterFilesByTags = (
    files: EnteFile[],
    filter: TagFilterSelection,
    fileIdsByTag: Map<string, Set<number>>,
    options?: TagFilterOptions,
): EnteFile[] => {
    if (!isTagFilterActive(filter)) {
        return files;
    }

    const matchingIds = resolveMatchingIds(
        files,
        allFileIds(files),
        filter,
        fileIdsByTag,
        options?.favoriteFileIds,
    );

    return files.filter((file) => matchingIds.has(file.id));
};

/**
 * Count files matching the tag filter within a candidate id set.
 */
export const countFilesMatchingTagFilter = (
    candidateFileIds: Set<number>,
    filter: TagFilterSelection,
    fileIdsByTag: Map<string, Set<number>>,
    files?: EnteFile[],
    options?: TagFilterOptions,
): number => {
    if (!isTagFilterActive(filter)) {
        return candidateFileIds.size;
    }

    const candidateFiles =
        files?.filter((file) => candidateFileIds.has(file.id)) ?? [];

    return resolveMatchingIds(
        candidateFiles,
        candidateFileIds,
        filter,
        fileIdsByTag,
        options?.favoriteFileIds,
    ).size;
};

/** Number of files in scope that have no user tags. */
export const countUntaggedInCandidates = (
    candidateFileIds: Set<number>,
    fileIdsByTag: Map<string, Set<number>>,
): number =>
    untaggedIdsInCandidates(candidateFileIds, fileIdsByTag).size;

/** Number of files in scope that have at least one user tag. */
export const countTaggedInCandidates = (
    candidateFileIds: Set<number>,
    fileIdsByTag: Map<string, Set<number>>,
): number =>
    taggedIdsInCandidates(candidateFileIds, fileIdsByTag).size;

/** Number of favourited files within a candidate id set. */
export const countFavoritesInCandidates = (
    candidateFileIds: Set<number>,
    favoriteFileIds: Set<number>,
): number => {
    let count = 0;
    for (const id of candidateFileIds) {
        if (favoriteFileIds.has(id)) {
            count += 1;
        }
    }
    return count;
};

/** Number of non-favourited files within a candidate id set. */
export const countNotFavoritesInCandidates = (
    candidateFileIds: Set<number>,
    favoriteFileIds: Set<number>,
): number => {
    let count = 0;
    for (const id of candidateFileIds) {
        if (!favoriteFileIds.has(id)) {
            count += 1;
        }
    }
    return count;
};

/** Number of files tagged with a given name. */
export const tagFileCount = (
    tag: string,
    fileIdsByTag: Map<string, Set<number>>,
): number => fileIdsByTag.get(tag)?.size ?? 0;
