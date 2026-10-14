import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import { isTagIncludedInEffectsPresence } from "@/lib/tag-types";
import {
    extractUserTags,
    isManuallyCroppedFile,
    isManuallyRotatedFile,
    isSystemTag,
} from "@/lib/tags";

export type TagFilterMode = "include" | "exclude";

/** How sibling clauses combine. `only` = exact user-tag set (includes only). */
export type TagFilterJoin = "and" | "or" | "only";

export type TagScope = "all" | "tagged" | "untagged";

export type FavoritesScope = "all" | "favorites" | "not-favorites";

export type MediaScope = "all" | "photo" | "video";

/** Manual crop presence: user crop (not auto-crop) vs everything else. */
export type CroppedScope = "all" | "cropped" | "not-cropped";

/** Manual rotate presence: files rotated in this app vs everything else. */
export type RotatedScope = "all" | "rotated" | "not-rotated";

export interface TagFilterClauseNode {
    kind: "clause";
    id: string;
    tag: string;
    mode: TagFilterMode;
}

/** One kit as a single filter unit (Has = all tags; Not = missing at least one). */
export interface TagFilterKitNode {
    kind: "kit";
    id: string;
    presetId: string;
    name: string;
    tags: string[];
    mode: TagFilterMode;
}

export interface TagFilterGroup {
    kind: "group";
    id: string;
    op: TagFilterJoin;
    children: TagFilterNode[];
}

export type TagFilterNode =
    TagFilterClauseNode |
    TagFilterKitNode |
    TagFilterGroup;

export interface TagFilterSelection {
    tagScope: TagScope;
    favoritesScope: FavoritesScope;
    mediaScope: MediaScope;
    croppedScope: CroppedScope;
    rotatedScope: RotatedScope;
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
    rotatedScope: "all",
    root: createEmptyTagFilterRoot(),
});

export const isTagFilterGroup = (node: TagFilterNode): node is TagFilterGroup =>
    node.kind === "group";

export const isTagFilterClause = (
    node: TagFilterNode,
): node is TagFilterClauseNode => node.kind === "clause";

export const isTagFilterKit = (node: TagFilterNode): node is TagFilterKitNode =>
    node.kind === "kit";

/** Count clause and kit leaves in the filter tree. */
export const countTagFilterClauses = (root: TagFilterGroup): number => {
    let count = 0;
    const walk = (node: TagFilterNode): void => {
        if (isTagFilterClause(node) || isTagFilterKit(node)) {
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
): TagFilterMode | null => findClauseInGroup(root, tag)?.mode ?? null;

/** True when every root child is a clause or kit (no nested groups). */
export const isFlatTagFilterRoot = (root: TagFilterGroup): boolean =>
    root.children.every(
        (child) => isTagFilterClause(child) || isTagFilterKit(child),
    );

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

export type ScopeKey = Exclude<keyof TagFilterSelection, "root">;

interface ScopeDefinition {
    key: ScopeKey;
    /**
     * Reserved filter name per non-"all" scope value. Shown in
     * {@link describeTagFilter} and rejected as a tag name by
     * {@link isReservedTag}.
     */
    filterNames: Readonly<Record<string, string>>;
    /**
     * Present for scopes decided from the file alone: `matchValue` is the
     * scope value that keeps files passing `matches`; the other value keeps
     * the rest.
     */
    fileTest?: { matchValue: string; matches: (file: EnteFile) => boolean };
}

/** Gallery pseudo-tag for files with no user tags. */
const UNTAGGED_FILTER = "untagged";

/** Gallery pseudo-tag for files that have at least one user tag. */
const TAGGED_FILTER = "tagged";

/** Every filter scope, in the order they appear in {@link describeTagFilter}. */
const SCOPES: readonly ScopeDefinition[] = [
    {
        key: "tagScope",
        filterNames: { tagged: TAGGED_FILTER, untagged: UNTAGGED_FILTER },
    },
    {
        key: "favoritesScope",
        filterNames: {
            favorites: "favourites",
            "not-favorites": "not-favourites",
        },
    },
    {
        key: "mediaScope",
        filterNames: { photo: "photo", video: "video" },
        fileTest: {
            matchValue: "video",
            matches: (file) => file.metadata.fileType === FileType.video,
        },
    },
    {
        key: "croppedScope",
        filterNames: {
            cropped: "manually-cropped",
            "not-cropped": "not-manually-cropped",
        },
        fileTest: { matchValue: "cropped", matches: isManuallyCroppedFile },
    },
    {
        key: "rotatedScope",
        filterNames: {
            rotated: "manually-rotated",
            "not-rotated": "not-manually-rotated",
        },
        fileTest: { matchValue: "rotated", matches: isManuallyRotatedFile },
    },
];

const RESERVED_FILTER_NAMES = new Set(
    SCOPES.flatMap((scope) => Object.values(scope.filterNames)),
);

/** Tag index lookups shared by presence counts and filter evaluation. */
interface TagIndexContext {
    fileIdsByTag: Map<string, Set<number>>;
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>;
}

/** Everything {@link evaluateTagFilterNode} needs besides the node and candidates. */
interface FilterContext extends TagIndexContext, TagFilterOptions {
    files: EnteFile[];
    /** Built on first use by {@link exactUserTagSetIds}, then shared. */
    fileById?: Map<number, EnteFile>;
}

const hasActiveScope = (filter: TagFilterSelection): boolean =>
    SCOPES.some((scope) => filter[scope.key] !== "all");

export const isTagFilterActive = (filter: TagFilterSelection): boolean =>
    hasActiveScope(filter) || countTagFilterClauses(filter.root) > 0;

const describeClauseNode = (clause: TagFilterClauseNode): string =>
    clause.mode === "exclude" ? `not ${clause.tag}` : clause.tag;

const describeKitNode = (kit: TagFilterKitNode): string =>
    kit.mode === "exclude" ? `not kit:${kit.name}` : `kit:${kit.name}`;

const describeLeafOrGroup = (node: TagFilterNode): string => {
    if (isTagFilterClause(node)) {
        return describeClauseNode(node);
    }
    if (isTagFilterKit(node)) {
        return describeKitNode(node);
    }
    const inner = describeGroupNode(node);
    return inner ? `(${inner})` : "";
};

/** Children of an `only` group, split by how each takes part in the match. */
interface OnlyGroupParts {
    /** Tags the file's user tags must equal exactly. */
    includeTags: string[];
    /** Exclude clauses and kits, in child order. */
    excludes: (TagFilterClauseNode | TagFilterKitNode)[];
    nestedGroups: TagFilterGroup[];
}

const splitOnlyGroup = (group: TagFilterGroup): OnlyGroupParts => {
    const parts: OnlyGroupParts = {
        includeTags: [],
        excludes: [],
        nestedGroups: [],
    };
    for (const child of group.children) {
        if (isTagFilterGroup(child)) {
            parts.nestedGroups.push(child);
        } else if (child.mode === "exclude") {
            parts.excludes.push(child);
        } else if (isTagFilterClause(child)) {
            parts.includeTags.push(child.tag);
        } else {
            parts.includeTags.push(...child.tags);
        }
    }
    return parts;
};

const describeGroupNode = (group: TagFilterGroup): string => {
    if (group.children.length === 0) {
        return "";
    }
    if (group.op === "only") {
        const { includeTags, excludes, nestedGroups } = splitOnlyGroup(group);
        const onlyCore =
            includeTags.length > 0 ?
                `only [${includeTags.join(" + ")}]` :
                "only []";
        return [
            onlyCore,
            ...excludes.map(describeLeafOrGroup),
            ...nestedGroups
                .map(describeLeafOrGroup)
                .filter((part) => part.length > 0),
        ].join(" AND ");
    }
    return group.children
        .map(describeLeafOrGroup)
        .filter((part) => part.length > 0)
        .join(` ${group.op.toUpperCase()} `);
};

/**
 * Human-readable summary of the active filter (e.g. "tagged · favourites · (selfie AND not vietnam)").
 */
export const describeTagFilter = (filter: TagFilterSelection): string =>
    [
        ...SCOPES.map((scope) => scope.filterNames[filter[scope.key]]),
        describeGroupNode(filter.root),
    ]
        .filter(Boolean)
        .join(" · ");

/** Instruction label for one tag clause in the query builder. */
export const describeTagFilterClause = (clause: TagFilterClauseNode): string =>
    clause.mode === "exclude" ? `Not ${clause.tag}` : `Has ${clause.tag}`;

/** Instruction label for one kit node in the query builder. */
export const describeTagFilterKit = (kit: TagFilterKitNode): string =>
    kit.mode === "exclude" ? `Not kit ${kit.name}` : `Has kit ${kit.name}`;

/**
 * Return true when the name is reserved and must not be assigned to files.
 */
export const isReservedTag = (tag: string): boolean =>
    isSystemTag(tag) || RESERVED_FILTER_NAMES.has(tag);

const intersectIds = (
    left: Set<number>,
    right: Set<number>,
): Set<number> => {
    if (left.size === 0 || right.size === 0) {
        return new Set();
    }
    const small = left.size <= right.size ? left : right;
    const large = left.size <= right.size ? right : left;
    const next = new Set<number>();
    for (const id of small) {
        if (large.has(id)) {
            next.add(id);
        }
    }
    return next;
};

const allFileIds = (files: EnteFile[]): Set<number> => {
    const ids = new Set<number>();
    for (const file of files) {
        ids.add(file.id);
    }
    return ids;
};

const untaggedIdsInCandidates = (
    candidateFileIds: Set<number>,
    ctx: TagIndexContext,
): Set<number> =>
    subtractIds(candidateFileIds, taggedIdsInCandidates(candidateFileIds, ctx));

const taggedIdsInCandidates = (
    candidateFileIds: Set<number>,
    { fileIdsByTag, includeInEffectsPresenceByName }: TagIndexContext,
): Set<number> => {
    const taggedIds = new Set<number>();
    for (const [tag, ids] of fileIdsByTag) {
        // System tags never count toward tagged/untagged presence.
        if (isSystemTag(tag)) {
            continue;
        }
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
): Set<number> => {
    if (remove.size === 0) {
        return universe;
    }
    const next = new Set<number>();
    for (const id of universe) {
        if (!remove.has(id)) {
            next.add(id);
        }
    }
    return next;
};

const unionIds = (
    left: Set<number>,
    right: Set<number>,
): Set<number> => {
    if (left.size === 0) {
        return right;
    }
    if (right.size === 0) {
        return left;
    }
    const next = new Set(left);
    for (const id of right) {
        next.add(id);
    }
    return next;
};

const tagIdsInCandidates = (
    tag: string,
    candidateIds: Set<number>,
    ctx: TagIndexContext,
): Set<number> => {
    if (tag === UNTAGGED_FILTER) {
        return untaggedIdsInCandidates(candidateIds, ctx);
    }
    const idsForTag = ctx.fileIdsByTag.get(tag);
    if (!idsForTag) {
        return new Set();
    }
    return intersectIds(idsForTag, candidateIds);
};

const evaluateClauseNode = (
    clause: TagFilterClauseNode,
    candidateIds: Set<number>,
    ctx: TagIndexContext,
): Set<number> => {
    const tagIds = tagIdsInCandidates(clause.tag, candidateIds, ctx);
    if (clause.mode === "include") {
        return tagIds;
    }
    return subtractIds(candidateIds, tagIds);
};

/**
 * Files among candidates that carry every kit tag (superset allowed).
 */
const kitMemberIdsInCandidates = (
    kitTags: readonly string[],
    candidateIds: Set<number>,
    ctx: TagIndexContext,
): Set<number> => {
    if (kitTags.length === 0) {
        return new Set();
    }
    let matching = candidateIds;
    for (const tag of kitTags) {
        matching = tagIdsInCandidates(tag, matching, ctx);
        if (matching.size === 0) {
            return matching;
        }
    }
    return matching;
};

const evaluateKitNode = (
    kit: TagFilterKitNode,
    candidateIds: Set<number>,
    ctx: TagIndexContext,
): Set<number> => {
    const members = kitMemberIdsInCandidates(kit.tags, candidateIds, ctx);
    if (kit.mode === "include") {
        return members;
    }
    return subtractIds(candidateIds, members);
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
    ctx: FilterContext,
    includeTags: string[],
): Set<number> => {
    const required = [...new Set(includeTags)];
    ctx.fileById ??= new Map(ctx.files.map((file) => [file.id, file] as const));
    const { fileById } = ctx;
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
const evaluateTagFilterNode = (
    node: TagFilterNode,
    candidateIds: Set<number>,
    ctx: FilterContext,
): Set<number> => {
    if (isTagFilterClause(node)) {
        return evaluateClauseNode(node, candidateIds, ctx);
    }

    if (isTagFilterKit(node)) {
        return evaluateKitNode(node, candidateIds, ctx);
    }

    if (node.children.length === 0) {
        return new Set<number>();
    }

    if (node.op === "only") {
        const { includeTags, excludes, nestedGroups } = splitOnlyGroup(node);

        let matchingIds = exactUserTagSetIds(
            candidateIds,
            ctx,
            includeTags,
        );

        for (const exclude of excludes) {
            matchingIds = evaluateTagFilterNode(exclude, matchingIds, ctx);
        }

        for (const group of nestedGroups) {
            matchingIds = intersectIds(
                matchingIds,
                evaluateTagFilterNode(group, matchingIds, ctx),
            );
        }

        return matchingIds;
    }

    if (node.op === "or") {
        let matchingIds = new Set<number>();
        for (const child of node.children) {
            matchingIds = unionIds(
                matchingIds,
                evaluateTagFilterNode(child, candidateIds, ctx),
            );
        }
        return matchingIds;
    }

    // AND: narrow sequentially so later clauses scan a smaller id set.
    let matchingIds = candidateIds;
    for (const child of node.children) {
        matchingIds = evaluateTagFilterNode(child, matchingIds, ctx);
        if (matchingIds.size === 0) {
            return matchingIds;
        }
    }
    return matchingIds;
};

const applyTagScope = (
    tagScope: TagScope,
    candidateIds: Set<number>,
    ctx: TagIndexContext,
): Set<number> => {
    if (tagScope === "untagged") {
        return untaggedIdsInCandidates(candidateIds, ctx);
    }
    if (tagScope === "tagged") {
        return taggedIdsInCandidates(candidateIds, ctx);
    }
    return candidateIds;
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
    return subtractIds(matchingIds, favoriteFileIds);
};

/** Apply every scope decided from the file alone (media, crop, rotate). */
const applyFileScopes = (
    matchingIds: Set<number>,
    files: EnteFile[],
    filter: TagFilterSelection,
): Set<number> => {
    let kept = matchingIds;
    for (const { key, fileTest } of SCOPES) {
        if (!fileTest || filter[key] === "all") {
            continue;
        }
        const wantMatch = filter[key] === fileTest.matchValue;
        const candidates = kept;
        kept = new Set<number>();
        for (const file of files) {
            if (
                candidates.has(file.id) &&
                fileTest.matches(file) === wantMatch
            ) {
                kept.add(file.id);
            }
        }
    }
    return kept;
};

const resolveMatchingIds = (
    candidateIds: Set<number>,
    filter: TagFilterSelection,
    ctx: FilterContext,
): Set<number> => {
    let matchingIds = applyTagScope(filter.tagScope, candidateIds, ctx);
    matchingIds = applyFavoritesScope(
        matchingIds,
        ctx.favoriteFileIds,
        filter.favoritesScope,
    );
    matchingIds = applyFileScopes(matchingIds, ctx.files, filter);

    if (matchingIds.size === 0) {
        return matchingIds;
    }

    if (countTagFilterClauses(filter.root) === 0) {
        return matchingIds;
    }

    return intersectIds(
        matchingIds,
        evaluateTagFilterNode(filter.root, matchingIds, ctx),
    );
};

/**
 * True when the filter is a flat AND of include-tag clauses with no scopes.
 * The common gallery tap (one tag / one kit) hits this path.
 */
const isFlatIncludeAndFilter = (filter: TagFilterSelection): boolean => {
    if (
        hasActiveScope(filter) ||
        filter.root.op !== "and" ||
        filter.root.children.length === 0
    ) {
        return false;
    }
    for (const child of filter.root.children) {
        if (!isTagFilterClause(child) || child.mode !== "include") {
            return false;
        }
        if (child.tag === UNTAGGED_FILTER || child.tag === TAGGED_FILTER) {
            return false;
        }
    }
    return true;
};

/**
 * Filter by intersecting tag posting lists, then one ordered pass.
 * Does not allocate a Set of every library id.
 */
const filterFilesByIncludeAnd = (
    files: EnteFile[],
    clauses: TagFilterClauseNode[],
    fileIdsByTag: Map<string, Set<number>>,
): EnteFile[] => {
    let matching: Set<number> | undefined;
    for (const clause of clauses) {
        const tagIds = fileIdsByTag.get(clause.tag);
        if (!tagIds || tagIds.size === 0) {
            return [];
        }
        matching = matching === undefined ? tagIds : intersectIds(matching, tagIds);
        if (matching.size === 0) {
            return [];
        }
    }
    if (!matching) {
        return files;
    }
    return files.filter((file) => matching.has(file.id));
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

    if (isFlatIncludeAndFilter(filter)) {
        return filterFilesByIncludeAnd(
            files,
            filter.root.children as TagFilterClauseNode[],
            fileIdsByTag,
        );
    }

    const matchingIds = resolveMatchingIds(allFileIds(files), filter, {
        ...options,
        files,
        fileIdsByTag,
    });

    return files.filter((file) => matchingIds.has(file.id));
};

/**
 * Whether a single file matches the active tag filter (scopes + expression).
 */
const fileMatchesTagFilter = (
    file: EnteFile,
    filter: TagFilterSelection,
    fileIdsByTag: Map<string, Set<number>>,
    options?: TagFilterOptions,
): boolean => {
    if (!isTagFilterActive(filter)) {
        return true;
    }
    return resolveMatchingIds(new Set([file.id]), filter, {
        ...options,
        files: [file],
        fileIdsByTag,
    }).has(file.id);
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
    const libraryIndex = libraryFiles.findIndex((entry) => entry.id === fileId);
    const file = libraryFiles[libraryIndex];
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
        // previousFiltered is a subsequence of libraryFiles (same order), so
        // count the visible files that precede it in one walk, no id map.
        let insertAt = 0;
        for (let i = 0; i < libraryIndex; i += 1) {
            if (libraryFiles[i]!.id === previousFiltered[insertAt]?.id) {
                insertAt += 1;
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

/** Number of files in scope that have no presence-counting user tags. */
export const countUntaggedInCandidates = (
    candidateFileIds: Set<number>,
    fileIdsByTag: Map<string, Set<number>>,
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>,
): number =>
    untaggedIdsInCandidates(candidateFileIds, {
        fileIdsByTag,
        includeInEffectsPresenceByName,
    }).size;

/** Number of files in scope with at least one presence-counting user tag. */
export const countTaggedInCandidates = (
    candidateFileIds: Set<number>,
    fileIdsByTag: Map<string, Set<number>>,
    includeInEffectsPresenceByName?: ReadonlyMap<string, boolean>,
): number =>
    taggedIdsInCandidates(candidateFileIds, {
        fileIdsByTag,
        includeInEffectsPresenceByName,
    }).size;

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

/** Photo / video / crop counts from one pass over {@link files}. */
export interface FileKindCounts {
    photos: number;
    videos: number;
    cropped: number;
    notCropped: number;
}

/**
 * Count photos, videos, and manual-crop presence in one walk of {@link files}.
 */
export const countFileKindsInCandidates = (
    candidateFileIds: Set<number>,
    files: EnteFile[],
): FileKindCounts => {
    let photos = 0;
    let videos = 0;
    let cropped = 0;
    let notCropped = 0;
    for (const file of files) {
        if (!candidateFileIds.has(file.id)) {
            continue;
        }
        if (file.metadata.fileType === FileType.video) {
            videos += 1;
        } else {
            photos += 1;
        }
        if (isManuallyCroppedFile(file)) {
            cropped += 1;
        } else {
            notCropped += 1;
        }
    }
    return { photos, videos, cropped, notCropped };
};
