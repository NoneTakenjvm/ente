import type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
import type { EnteFile } from "ente-media/file";
import { pubMagicVersionForPut } from "@/core/metadata";
import { extractTags, type OrganizerTagMetadata } from "@/lib/tags";
export type TagMutator = (currentTags: string[]) => string[];

type OrganizerMetadataBlock = OrganizerTagMetadata & {
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

/**
 * Normalize a tag name list: trimmed, unique, optionally capped at `max`.
 */
export const normalizeTagNameList = (
    names: string[],
    max = Infinity,
): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const name of names) {
        const normalized = normalizeTagName(name);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
        if (result.length >= max) {
            break;
        }
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
        tags: normalizeTagNameList(tags),
        updatedAt: Date.now() * 1000,
    },
});

export const applyTagMutator = (
    mutator: TagMutator,
    currentTags: string[],
): string[] => normalizeTagNameList(mutator(currentTags));

export const addTagNames = (currentTags: string[], ...names: string[]): string[] =>
    normalizeTagNameList([...currentTags, ...names]);

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
    return normalizeTagNameList(
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
    return normalizeTagNameList([...withoutSources, target]);
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

/**
 * Return a copy of {@link file} with organizer tags applied locally (no remote write).
 *
 * Preserves the existing pub-magic version when present. Ente versions start at
 * 1 — never invent `0`, or a later PUT will 409 against a real server version.
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
            version: pubMagicVersionForPut(file) ?? 1,
            count: file.pubMagicMetadata?.count ?? 0,
            data: mergedData as FilePublicMagicMetadataData,
        },
    };
};
