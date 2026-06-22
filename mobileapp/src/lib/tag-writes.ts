import type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
import type { EnteFile } from "ente-media/file";
import { extractTags, type OrganizerTagMetadata } from "@/lib/tags";
export type TagMutator = (currentTags: string[]) => string[];

export type OrganizerMetadataBlock = OrganizerTagMetadata & {
    updatedAt?: number;
};

export type OrganizerPublicMetadata = FilePublicMagicMetadataData & {
    _organizer_v1?: OrganizerMetadataBlock;
};

/**
 * Trim whitespace and reject empty tag names.
 */
export const normalizeTagName = (name: string): string | undefined => {
    const trimmed = name.trim();
    if (!trimmed) {
        return undefined;
    }
    return trimmed;
};

const dedupeTags = (tags: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const tag of tags) {
        const normalized = normalizeTagName(tag);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
};

/**
 * Build a public-metadata update for organizer tags.
 */
export const buildOrganizerUpdate = (
    tags: string[],
): Pick<OrganizerPublicMetadata, "_organizer_v1"> => ({
    _organizer_v1: {
        tags: dedupeTags(tags),
        updatedAt: Date.now() * 1000,
    },
});

export const applyTagMutator = (
    mutator: TagMutator,
    currentTags: string[],
): string[] => dedupeTags(mutator(currentTags));

export const addTagNames = (currentTags: string[], ...names: string[]): string[] =>
    dedupeTags([...currentTags, ...names]);

export const removeTagNames = (
    currentTags: string[],
    ...names: string[]
): string[] => {
    const remove = new Set(
        names
            .map(normalizeTagName)
            .filter((name): name is string => name !== undefined),
    );
    return currentTags.filter((tag) => !remove.has(tag));
};

export const replaceTagName = (
    currentTags: string[],
    oldName: string,
    newName: string,
): string[] => {
    const normalizedOld = normalizeTagName(oldName);
    const normalizedNew = normalizeTagName(newName);
    if (!normalizedOld || !normalizedNew) {
        return currentTags;
    }
    return dedupeTags(
        currentTags.map((tag) => (tag === normalizedOld ? normalizedNew : tag)),
    );
};

export const mergeTagNames = (
    currentTags: string[],
    sourceNames: string[],
    targetName: string,
): string[] => {
    const target = normalizeTagName(targetName);
    if (!target) {
        return currentTags;
    }
    const sources = new Set(
        sourceNames
            .map(normalizeTagName)
            .filter((name): name is string => name !== undefined),
    );
    const withoutSources = currentTags.filter((tag) => !sources.has(tag));
    return dedupeTags([...withoutSources, target]);
};

export const tagsForFile = (file: EnteFile, mutator: TagMutator): string[] =>
    applyTagMutator(mutator, extractTags(file));

/** Return true when two tag lists contain the same names (order ignored). */
export const tagsEqual = (left: string[], right: string[]): boolean => {
    if (left.length !== right.length) {
        return false;
    }
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((tag, index) => tag === sortedRight[index]);
};

export const organizerUpdateForFile = (
    file: EnteFile,
    mutator: TagMutator,
): Pick<OrganizerPublicMetadata, "_organizer_v1"> =>
    buildOrganizerUpdate(tagsForFile(file, mutator));

/**
 * Return a copy of {@link file} with organizer tags applied locally (no remote write).
 */
export const fileWithOrganizerTags = (
    file: EnteFile,
    tags: string[],
): EnteFile => {
    const update = buildOrganizerUpdate(tags);
    const mergedData = {
        ...file.pubMagicMetadata?.data,
        ...update,
    } as OrganizerPublicMetadata;
    return {
        ...file,
        pubMagicMetadata: {
            version: file.pubMagicMetadata?.version ?? 0,
            count: file.pubMagicMetadata?.count ?? 0,
            data: mergedData as FilePublicMagicMetadataData,
        },
    };
};
