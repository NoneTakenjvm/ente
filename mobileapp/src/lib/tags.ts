import type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import { getPublicMetadata } from "@/core/metadata";
import type { PersistedTagIndex } from "@/db/kv";
import { isTagIncludedInEffectsPresence } from "@/lib/tag-types";

export interface OrganizerTagMetadata {
    tags?: string[];
    updatedAt?: number;
}

export const SYSTEM_TAGS = new Set([
    "compressed",
    "rotated",
    "cropped",
    "auto-cropped",
]);

/** Gallery filter pseudo-tag for files with no user tags. */
export const UNTAGGED_FILTER = "untagged";

/** Gallery filter for files that have at least one user tag. */
export const TAGGED_FILTER = "tagged";

export const FAVORITES_FILTER = "favourites";

/** Gallery filter for files that are not favourited. */
export const NOT_FAVORITES_FILTER = "not-favourites";

/** Gallery filter for photos (images, GIFs, live photos). */
export const PHOTO_FILTER = "photo";

/** Gallery filter for videos. */
export const VIDEO_FILTER = "video";

/** Gallery filter for files manually cropped in this app. */
export const MANUALLY_CROPPED_FILTER = "manually-cropped";

/** Gallery filter for files that were not manually cropped. */
export const NOT_MANUALLY_CROPPED_FILTER = "not-manually-cropped";

export type TagFilterMode = "include" | "exclude";

/** How sibling clauses combine. `only` = exact user-tag set (includes only). */
export type TagFilterJoin = "and" | "or" | "only";

export type TagScope = "all" | "tagged" | "untagged";

export type FavoritesScope = "all" | "favorites" | "not-favorites";

export type MediaScope = "all" | "photo" | "video";

/** Manual crop presence: user crop (not auto-crop) vs everything else. */
export type CroppedScope = "all" | "cropped" | "not-cropped";

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
    mediaScope: MediaScope;
    croppedScope: CroppedScope;
    root: TagFilterGroup;
}

export interface TagFilterOptions {
    favoriteFileIds?: Set<number>;
    /**
     * Tags that count toward tagged/untagged. Absent map entries (and an
     * omitted map) count as included — see {@link isTagIncludedInEffectsPresence}.
     */
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>;
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
    mediaScope: "all",
    croppedScope: "all",
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
    filter.mediaScope !== "all" ||
    filter.croppedScope !== "all" ||
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
    if (group.op === "only") {
        const includeParts = group.children
            .filter(
                (child): child is TagFilterClauseNode =>
                    isTagFilterClause(child) && child.mode === "include",
            )
            .map((child) => child.tag);
        const excludeParts = group.children
            .filter(
                (child): child is TagFilterClauseNode =>
                    isTagFilterClause(child) && child.mode === "exclude",
            )
            .map((child) => `not ${child.tag}`);
        const nested = group.children
            .filter(isTagFilterGroup)
            .map((child) => {
                const inner = describeGroupNode(child);
                return inner ? `(${inner})` : "";
            })
            .filter((part) => part.length > 0);
        const onlyCore =
            includeParts.length > 0 ?
                `only [${includeParts.join(" + ")}]` :
                "only []";
        return [onlyCore, ...excludeParts, ...nested].join(" AND ");
    }
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
    if (filter.mediaScope === "photo") {
        parts.push(PHOTO_FILTER);
    } else if (filter.mediaScope === "video") {
        parts.push(VIDEO_FILTER);
    }
    if (filter.croppedScope === "cropped") {
        parts.push(MANUALLY_CROPPED_FILTER);
    } else if (filter.croppedScope === "not-cropped") {
        parts.push(NOT_MANUALLY_CROPPED_FILTER);
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
    tag === NOT_FAVORITES_FILTER ||
    tag === PHOTO_FILTER ||
    tag === VIDEO_FILTER ||
    tag === MANUALLY_CROPPED_FILTER ||
    tag === NOT_MANUALLY_CROPPED_FILTER;

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
 * Return true when the file was cropped by the user (not only by auto-crop).
 *
 * Manual crop stamps `cropped`; auto-crop stamps both `cropped` and
 * `auto-cropped`. Files only marked `auto-cropped` (scanned, no border) are
 * not manually cropped.
 */
export const isManuallyCroppedFile = (file: EnteFile): boolean => {
    const tags = extractTags(file);
    return tags.includes("cropped") && !tags.includes("auto-cropped");
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
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>,
): Set<number> => {
    const taggedIds = taggedIdsInCandidates(
        candidateFileIds,
        fileIdsByTag,
        includeInEffectsPresenceByName,
    );
    return new Set(
        [...candidateFileIds].filter((id) => !taggedIds.has(id)),
    );
};

const taggedIdsInCandidates = (
    candidateFileIds: Set<number>,
    fileIdsByTag: Map<string, Set<number>>,
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>,
): Set<number> => {
    const taggedIds = new Set<number>();
    for (const [tag, ids] of fileIdsByTag) {
        if (
            includeInEffectsPresenceByName &&
            !isTagIncludedInEffectsPresence(tag, includeInEffectsPresenceByName)
        ) {
            continue;
        }
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
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>,
): Set<number> => {
    const idsForTag = fileIdsByTag.get(tag) ?? new Set<number>();
    const scoped = new Set(
        [...idsForTag].filter((id) => candidateIds.has(id)),
    );
    if (tag === UNTAGGED_FILTER) {
        return untaggedIdsInCandidates(
            candidateIds,
            fileIdsByTag,
            includeInEffectsPresenceByName,
        );
    }
    return scoped;
};

const evaluateClauseNode = (
    clause: TagFilterClauseNode,
    candidateIds: Set<number>,
    files: EnteFile[],
    fileIdsByTag: Map<string, Set<number>>,
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>,
): Set<number> => {
    const tagIds = tagIdsInCandidates(
        clause.tag,
        candidateIds,
        files,
        fileIdsByTag,
        includeInEffectsPresenceByName,
    );
    if (clause.mode === "include") {
        return tagIds;
    }
    return subtractIds(candidateIds, tagIds);
};

/**
 * True when two tag lists are the same set (order-independent).
 */
const tagSetsEqual = (left: string[], right: string[]): boolean => {
    if (left.length !== right.length) {
        return false;
    }
    const rightSet = new Set(right);
    return left.every((tag) => rightSet.has(tag));
};

/**
 * File ids whose user tags match `includeTags` exactly (no extras).
 */
const exactUserTagSetIds = (
    candidateIds: Set<number>,
    files: EnteFile[],
    includeTags: string[],
): Set<number> => {
    const required = [...new Set(includeTags)];
    const fileById = new Map(files.map((file) => [file.id, file] as const));
    const matched = new Set<number>();
    for (const id of candidateIds) {
        const file = fileById.get(id);
        if (!file) {
            continue;
        }
        if (tagSetsEqual(extractUserTags(file), required)) {
            matched.add(id);
        }
    }
    return matched;
};

/**
 * Evaluate a tag filter expression tree against a candidate file id set.
 */
export const evaluateTagFilterNode = (
    node: TagFilterNode,
    candidateIds: Set<number>,
    files: EnteFile[],
    fileIdsByTag: Map<string, Set<number>>,
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>,
): Set<number> => {
    if (isTagFilterClause(node)) {
        return evaluateClauseNode(
            node,
            candidateIds,
            files,
            fileIdsByTag,
            includeInEffectsPresenceByName,
        );
    }

    if (node.children.length === 0) {
        return candidateIds;
    }

    if (node.op === "only") {
        const includeTags: string[] = [];
        const excludeClauses: TagFilterClauseNode[] = [];
        const nestedGroups: TagFilterGroup[] = [];
        for (const child of node.children) {
            if (isTagFilterClause(child)) {
                if (child.mode === "include") {
                    includeTags.push(child.tag);
                } else {
                    excludeClauses.push(child);
                }
            } else {
                nestedGroups.push(child);
            }
        }

        let matchingIds = exactUserTagSetIds(
            candidateIds,
            files,
            includeTags,
        );

        for (const clause of excludeClauses) {
            matchingIds = evaluateClauseNode(
                clause,
                matchingIds,
                files,
                fileIdsByTag,
                includeInEffectsPresenceByName,
            );
        }

        for (const group of nestedGroups) {
            matchingIds = intersectIds(
                matchingIds,
                evaluateTagFilterNode(
                    group,
                    matchingIds,
                    files,
                    fileIdsByTag,
                    includeInEffectsPresenceByName,
                ),
            );
        }

        return matchingIds;
    }

    const childSets = node.children.map((child) => evaluateTagFilterNode(
        child,
        candidateIds,
        files,
        fileIdsByTag,
        includeInEffectsPresenceByName,
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
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>,
): Set<number> | undefined => {
    if (tagScope === "untagged") {
        return untaggedIdsInCandidates(
            candidateIds,
            fileIdsByTag,
            includeInEffectsPresenceByName,
        );
    }
    if (tagScope === "tagged") {
        return taggedIdsInCandidates(
            candidateIds,
            fileIdsByTag,
            includeInEffectsPresenceByName,
        );
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

const applyMediaScope = (
    matchingIds: Set<number>,
    files: EnteFile[],
    mediaScope: MediaScope,
): Set<number> => {
    if (mediaScope === "all") {
        return matchingIds;
    }
    const fileById = new Map(files.map((file) => [file.id, file] as const));
    const next = new Set<number>();
    for (const id of matchingIds) {
        const file = fileById.get(id);
        if (!file) {
            continue;
        }
        const isVideo = file.metadata.fileType === FileType.video;
        if (mediaScope === "video" ? isVideo : !isVideo) {
            next.add(id);
        }
    }
    return next;
};

const applyCroppedScope = (
    matchingIds: Set<number>,
    files: EnteFile[],
    croppedScope: CroppedScope,
): Set<number> => {
    if (croppedScope === "all") {
        return matchingIds;
    }
    const fileById = new Map(files.map((file) => [file.id, file] as const));
    const next = new Set<number>();
    for (const id of matchingIds) {
        const file = fileById.get(id);
        if (!file) {
            continue;
        }
        const manuallyCropped = isManuallyCroppedFile(file);
        if (croppedScope === "cropped" ? manuallyCropped : !manuallyCropped) {
            next.add(id);
        }
    }
    return next;
};

const resolveMatchingIds = (
    files: EnteFile[],
    candidateIds: Set<number>,
    filter: TagFilterSelection,
    fileIdsByTag: Map<string, Set<number>>,
    favoriteFileIds: Set<number> | undefined,
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>,
): Set<number> => {
    let matchingIds = new Set(candidateIds);

    const scopeIds = applyTagScope(
        filter.tagScope,
        matchingIds,
        fileIdsByTag,
        includeInEffectsPresenceByName,
    );
    if (scopeIds !== undefined) {
        matchingIds = scopeIds;
    }

    matchingIds = applyFavoritesScope(
        matchingIds,
        favoriteFileIds,
        filter.favoritesScope,
    );

    matchingIds = applyMediaScope(matchingIds, files, filter.mediaScope);
    matchingIds = applyCroppedScope(matchingIds, files, filter.croppedScope);

    if (matchingIds.size === 0) {
        return matchingIds;
    }

    const exprIds = evaluateTagFilterNode(
        filter.root,
        matchingIds,
        files,
        fileIdsByTag,
        includeInEffectsPresenceByName,
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
        options?.includeInEffectsPresenceByName,
    );

    return files.filter((file) => matchingIds.has(file.id));
};

/**
 * Whether a single file matches the active tag filter (scopes + expression).
 */
export const fileMatchesTagFilter = (
    file: EnteFile,
    filter: TagFilterSelection,
    fileIdsByTag: Map<string, Set<number>>,
    options?: TagFilterOptions,
): boolean => {
    if (!isTagFilterActive(filter)) {
        return true;
    }
    return resolveMatchingIds(
        [file],
        new Set([file.id]),
        filter,
        fileIdsByTag,
        options?.favoriteFileIds,
        options?.includeInEffectsPresenceByName,
    ).has(file.id);
};

/**
 * Patch a previously filtered list after one file's tags changed.
 *
 * Keeps gallery order for other files; inserts the file at the end of its
 * peer group when it newly matches (callers that need strict sort should
 * fall back to a full {@link filterFilesByTags}).
 *
 * @returns the patched list, or `null` when a full refilter is safer
 */
export const patchFilteredFilesForTagTouch = (
    previousFiltered: EnteFile[],
    libraryFiles: EnteFile[],
    fileId: number,
    filter: TagFilterSelection,
    fileIdsByTag: Map<string, Set<number>>,
    options?: TagFilterOptions,
): EnteFile[] | null => {
    const file = libraryFiles.find((entry) => entry.id === fileId);
    if (!file) {
        return previousFiltered.filter((entry) => entry.id !== fileId);
    }
    const matches = fileMatchesTagFilter(file, filter, fileIdsByTag, options);
    const existingIndex = previousFiltered.findIndex(
        (entry) => entry.id === fileId,
    );
    if (matches) {
        if (existingIndex >= 0) {
            const next = previousFiltered.slice();
            next[existingIndex] = file;
            return next;
        }
        // Insert at library order position among currently visible files.
        const libraryOrder = new Map(
            libraryFiles.map((entry, index) => [entry.id, index]),
        );
        const libraryIndex = libraryOrder.get(fileId);
        if (libraryIndex === undefined) {
            return null;
        }
        let insertAt = previousFiltered.length;
        for (let i = 0; i < previousFiltered.length; i += 1) {
            const peerIndex = libraryOrder.get(previousFiltered[i]!.id);
            if (peerIndex !== undefined && peerIndex > libraryIndex) {
                insertAt = i;
                break;
            }
        }
        const next = previousFiltered.slice();
        next.splice(insertAt, 0, file);
        return next;
    }
    if (existingIndex < 0) {
        return previousFiltered;
    }
    const next = previousFiltered.slice();
    next.splice(existingIndex, 1);
    return next;
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
        options?.includeInEffectsPresenceByName,
    ).size;
};

/** Number of files in scope that have no presence-counting user tags. */
export const countUntaggedInCandidates = (
    candidateFileIds: Set<number>,
    fileIdsByTag: Map<string, Set<number>>,
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>,
): number =>
    untaggedIdsInCandidates(
        candidateFileIds,
        fileIdsByTag,
        includeInEffectsPresenceByName,
    ).size;

/** Number of files in scope with at least one presence-counting user tag. */
export const countTaggedInCandidates = (
    candidateFileIds: Set<number>,
    fileIdsByTag: Map<string, Set<number>>,
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>,
): number =>
    taggedIdsInCandidates(
        candidateFileIds,
        fileIdsByTag,
        includeInEffectsPresenceByName,
    ).size;

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

/** Number of photos (non-video) within a candidate id set. */
export const countPhotosInCandidates = (
    candidateFileIds: Set<number>,
    files: EnteFile[],
): number => {
    let count = 0;
    for (const file of files) {
        if (
            candidateFileIds.has(file.id) &&
            file.metadata.fileType !== FileType.video
        ) {
            count += 1;
        }
    }
    return count;
};

/** Number of videos within a candidate id set. */
export const countVideosInCandidates = (
    candidateFileIds: Set<number>,
    files: EnteFile[],
): number => {
    let count = 0;
    for (const file of files) {
        if (
            candidateFileIds.has(file.id) &&
            file.metadata.fileType === FileType.video
        ) {
            count += 1;
        }
    }
    return count;
};

/** Number of manually cropped files within a candidate id set. */
export const countManuallyCroppedInCandidates = (
    candidateFileIds: Set<number>,
    files: EnteFile[],
): number => {
    let count = 0;
    for (const file of files) {
        if (candidateFileIds.has(file.id) && isManuallyCroppedFile(file)) {
            count += 1;
        }
    }
    return count;
};

/** Number of files that were not manually cropped within a candidate id set. */
export const countNotManuallyCroppedInCandidates = (
    candidateFileIds: Set<number>,
    files: EnteFile[],
): number => {
    let count = 0;
    for (const file of files) {
        if (candidateFileIds.has(file.id) && !isManuallyCroppedFile(file)) {
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
