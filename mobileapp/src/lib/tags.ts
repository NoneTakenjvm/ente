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

export type TagFilterMode = "include" | "exclude";

export type TagFilterJoin = "and" | "or";

export interface TagFilterClause {
    tag: string;
    mode: TagFilterMode;
    /** How this clause combines with the query so far. Ignored for the first clause. */
    join: TagFilterJoin;
}

export interface TagFilterSelection {
    untagged: boolean;
    tagged: boolean;
    clauses: TagFilterClause[];
}

export const emptyTagFilter = (): TagFilterSelection => ({
    untagged: false,
    tagged: false,
    clauses: [],
});

export const isTagFilterActive = (filter: TagFilterSelection): boolean =>
    filter.untagged || filter.tagged || filter.clauses.length > 0;

/**
 * Human-readable summary of the active filter (e.g. "selfie, not vietnam").
 */
export const describeTagFilter = (filter: TagFilterSelection): string => {
    const parts: string[] = [];
    if (filter.untagged) {
        parts.push(UNTAGGED_FILTER);
    }
    if (filter.tagged) {
        parts.push(TAGGED_FILTER);
    }
    for (let i = 0; i < filter.clauses.length; i++) {
        const clause = filter.clauses[i];
        const label =
            clause.mode === "exclude" ? `not ${clause.tag}` : clause.tag;
        if (i === 0) {
            parts.push(label);
        } else {
            parts.push(`${clause.join.toUpperCase()} ${label}`);
        }
    }
    return parts.join(", ");
};

/** Instruction label for one tag clause in the query builder. */
export const describeTagFilterClause = (clause: TagFilterClause): string =>
    clause.mode === "exclude" ? `Not ${clause.tag}` : `Has ${clause.tag}`;

/**
 * Return true when the tag is reserved for internal organizer workflows.
 */
export const isSystemTag = (tag: string): boolean => SYSTEM_TAGS.has(tag);

/**
 * Return true when the name is reserved and must not be assigned to files.
 */
export const isReservedTag = (tag: string): boolean =>
    isSystemTag(tag) || tag === UNTAGGED_FILTER || tag === TAGGED_FILTER;

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

const fileIdsForFilterTag = (
    tag: string,
    files: EnteFile[],
    fileIdsByTag: Map<string, Set<number>>,
): Set<number> => {
    if (tag === UNTAGGED_FILTER) {
        return new Set(
            files
                .filter((file) => extractUserTags(file).length === 0)
                .map((file) => file.id),
        );
    }
    return fileIdsByTag.get(tag) ?? new Set<number>();
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

const fileIdsForFilterTagInCandidates = (
    tag: string,
    files: EnteFile[],
    fileIdsByTag: Map<string, Set<number>>,
): Set<number> => {
    const candidateIds = allFileIds(files);
    if (tag === UNTAGGED_FILTER) {
        return untaggedIdsInCandidates(candidateIds, fileIdsByTag);
    }
    const idsForTag = fileIdsByTag.get(tag) ?? new Set<number>();
    return new Set([...idsForTag].filter((id) => candidateIds.has(id)));
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
    const idsForTag = fileIdsForFilterTagInCandidates(
        tag,
        files,
        fileIdsByTag,
    );
    return intersectIds(candidateIds, idsForTag);
};

const applyFirstClause = (
    clause: TagFilterClause,
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

const applyJoinClause = (
    matchingIds: Set<number>,
    clause: TagFilterClause,
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
    if (clause.join === "or") {
        if (clause.mode === "include") {
            return unionIds(matchingIds, tagIds);
        }
        return unionIds(matchingIds, subtractIds(candidateIds, tagIds));
    }
    if (clause.mode === "include") {
        return intersectIds(matchingIds, tagIds);
    }
    return subtractIds(matchingIds, tagIds);
};

const applyTagFilterClauses = (
    files: EnteFile[],
    candidateIds: Set<number>,
    clauses: TagFilterClause[],
    fileIdsByTag: Map<string, Set<number>>,
): Set<number> => {
    if (clauses.length === 0) {
        return candidateIds;
    }

    let matchingIds = applyFirstClause(
        clauses[0],
        candidateIds,
        files,
        fileIdsByTag,
    );
    for (let i = 1; i < clauses.length; i++) {
        matchingIds = applyJoinClause(
            matchingIds,
            clauses[i],
            candidateIds,
            files,
            fileIdsByTag,
        );
        if (matchingIds.size === 0) {
            return matchingIds;
        }
    }
    return matchingIds;
};

/**
 * Keep files matching include clauses (AND) while applying exclude clauses (AND NOT).
 */
export const filterFilesByTags = (
    files: EnteFile[],
    filter: TagFilterSelection,
    fileIdsByTag: Map<string, Set<number>>,
): EnteFile[] => {
    if (!isTagFilterActive(filter)) {
        return files;
    }

    let matchingIds: Set<number> | undefined;
    if (filter.untagged) {
        matchingIds = fileIdsForFilterTag(
            UNTAGGED_FILTER,
            files,
            fileIdsByTag,
        );
        if (matchingIds.size === 0) {
            return [];
        }
    } else if (filter.tagged) {
        matchingIds = taggedIdsInCandidates(allFileIds(files), fileIdsByTag);
        if (matchingIds.size === 0) {
            return [];
        }
    }

    const clauseIds = applyTagFilterClauses(
        files,
        matchingIds ?? allFileIds(files),
        filter.clauses,
        fileIdsByTag,
    );

    if (matchingIds !== undefined) {
        matchingIds = intersectIds(matchingIds, clauseIds);
    } else {
        matchingIds = clauseIds;
    }

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
): number => {
    if (!isTagFilterActive(filter)) {
        return candidateFileIds.size;
    }

    const candidateFiles =
        files?.filter((file) => candidateFileIds.has(file.id)) ?? [];
    const scopedIds = new Set(candidateFileIds);

    let matchingIds: Set<number> | undefined;
    if (filter.untagged) {
        matchingIds = untaggedIdsInCandidates(scopedIds, fileIdsByTag);
        if (matchingIds.size === 0) {
            return 0;
        }
    } else if (filter.tagged) {
        matchingIds = taggedIdsInCandidates(scopedIds, fileIdsByTag);
        if (matchingIds.size === 0) {
            return 0;
        }
    }

    const clauseIds = applyTagFilterClauses(
        candidateFiles,
        matchingIds ?? scopedIds,
        filter.clauses,
        fileIdsByTag,
    );

    if (matchingIds !== undefined) {
        matchingIds = intersectIds(matchingIds, clauseIds);
    } else {
        matchingIds = clauseIds;
    }

    return matchingIds.size;
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

/** Number of files tagged with a given name. */
export const tagFileCount = (
    tag: string,
    fileIdsByTag: Map<string, Set<number>>,
): number => fileIdsByTag.get(tag)?.size ?? 0;
