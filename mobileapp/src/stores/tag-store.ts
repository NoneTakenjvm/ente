import { create } from "zustand";
import type { StateCreator } from "zustand";
import type { PersistedTagIndex } from "@/db/kv";
import { saveEncryptedTagIndex } from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";
import { enqueueOrganizerConfigPatch } from "@/lib/organizer-config-save-queue";
import {
    configFromPersisted,
    configToPersisted,
    DEFAULT_TAG_TYPE,
    normalizeTagTypeName,
    type PersistedTagTypeConfig,
} from "@/lib/tag-types";
import {
    buildTagIndex,
    emptyTagFilter,
    isTagFilterActive,
    isReservedTag,
    tagIndexToMaps,
    type TagFilterJoin,
    type TagFilterMode,
    type TagFilterSelection,
} from "@/lib/tags";
import type { EnteFile } from "ente-media/file";

interface TagState {
    tags: string[];
    fileIdsByTag: Map<string, Set<number>>;
    tagTypes: string[];
    tagTypeByName: Map<string, string>;
    tagFilter: TagFilterSelection;
    hydrateFromPersisted: (index: PersistedTagIndex) => void;
    hydrateTagTypes: (config: PersistedTagTypeConfig | undefined) => void;
    rebuildFromFiles: (files: EnteFile[]) => void;
    toggleUntaggedFilter: () => void;
    toggleTaggedFilter: () => void;
    setTagFilterMode: (tag: string, mode: TagFilterMode | null) => void;
    setTagFilterJoin: (tag: string, join: TagFilterJoin) => void;
    clearFilters: () => void;
    ensureTagType: (typeName: string) => void;
    setTagType: (tagName: string, typeName: string) => void;
    applyFileTags: (fileId: number, tags: string[]) => void;
    applyTagRename: (oldName: string, newName: string) => void;
    applyTagDelete: (tagName: string) => void;
    applyTagMerge: (sourceNames: string[], targetName: string) => void;
    reset: () => void;
}

const initialTypeState = configFromPersisted(undefined);

const initialTagState: Pick<
    TagState,
    "tags" | "fileIdsByTag" | "tagTypes" | "tagTypeByName" | "tagFilter"
> = {
    tags: [],
    fileIdsByTag: new Map(),
    tagTypes: initialTypeState.types,
    tagTypeByName: initialTypeState.tagTypeByName,
    tagFilter: emptyTagFilter(),
};

const indexFromMaps = (
    tags: string[],
    fileIdsByTag: Map<string, Set<number>>,
): PersistedTagIndex => {
    const fileIdsByTagRecord: Record<string, number[]> = {};
    for (const tag of tags) {
        fileIdsByTagRecord[tag] = [...(fileIdsByTag.get(tag) ?? [])];
    }
    return { tags, fileIdsByTag: fileIdsByTagRecord };
};

const persistCurrentIndex = (
    tags: string[],
    fileIdsByTag: Map<string, Set<number>>,
): void => {
    void saveEncryptedTagIndex(
        indexFromMaps(tags, fileIdsByTag),
        getSessionCacheKey(),
    );
};

const persistTagTypesConfig = (
    tagTypes: string[],
    tagTypeByName: Map<string, string>,
): void => {
    enqueueOrganizerConfigPatch({
        tagTypes: configToPersisted(tagTypes, tagTypeByName),
    });
};

const removeFileFromIndex = (
    fileIdsByTag: Map<string, Set<number>>,
    fileId: number,
): void => {
    for (const [tag, ids] of fileIdsByTag) {
        if (!ids.has(fileId)) {
            continue;
        }
        const next = new Set(ids);
        next.delete(fileId);
        if (next.size === 0) {
            fileIdsByTag.delete(tag);
        } else {
            fileIdsByTag.set(tag, next);
        }
    }
};

const withoutTagClause = (
    filter: TagFilterSelection,
    tag: string,
): TagFilterSelection => ({
    ...filter,
    clauses: filter.clauses.filter((clause) => clause.tag !== tag),
});

const mergeTypeForTarget = (
    targetName: string,
    sourceNames: string[],
    tagTypeByName: Map<string, string>,
): string | undefined => {
    if (tagTypeByName.has(targetName)) {
        return tagTypeByName.get(targetName);
    }
    for (const source of sourceNames) {
        const type = tagTypeByName.get(source);
        if (type) {
            return type;
        }
    }
    return undefined;
};

const createTagStore: StateCreator<TagState> = (set, get) => ({
    ...initialTagState,

    hydrateFromPersisted: (index: PersistedTagIndex): void => {
        const { tags, fileIdsByTag } = tagIndexToMaps(index);
        set({ tags, fileIdsByTag });
    },

    hydrateTagTypes: (config: PersistedTagTypeConfig | undefined): void => {
        const { types, tagTypeByName } = configFromPersisted(config);
        set({ tagTypes: types, tagTypeByName });
    },

    rebuildFromFiles: (files: EnteFile[]): void => {
        const index = buildTagIndex(files);
        const { tags, fileIdsByTag } = tagIndexToMaps(index);
        set({ tags, fileIdsByTag });
        persistCurrentIndex(tags, fileIdsByTag);
    },

    toggleUntaggedFilter: (): void => {
        const { tagFilter } = get();
        const nextUntagged = !tagFilter.untagged;
        set({
            tagFilter: {
                untagged: nextUntagged,
                tagged: false,
                clauses: nextUntagged ? [] : tagFilter.clauses,
            },
        });
    },

    toggleTaggedFilter: (): void => {
        const { tagFilter } = get();
        const nextTagged = !tagFilter.tagged;
        set({
            tagFilter: {
                untagged: false,
                tagged: nextTagged,
                clauses: tagFilter.clauses,
            },
        });
    },

    setTagFilterMode: (tag: string, mode: TagFilterMode | null): void => {
        const { tagFilter } = get();
        const withoutTag = withoutTagClause(tagFilter, tag);
        if (mode === null) {
            set({
                tagFilter: {
                    ...withoutTag,
                    untagged: false,
                },
            });
            return;
        }
        set({
            tagFilter: {
                untagged: false,
                tagged: tagFilter.tagged,
                clauses: [
                    ...withoutTag.clauses,
                    { tag, mode, join: "and" as const },
                ],
            },
        });
    },

    setTagFilterJoin: (tag: string, join: TagFilterJoin): void => {
        const { tagFilter } = get();
        set({
            tagFilter: {
                ...tagFilter,
                clauses: tagFilter.clauses.map((clause) =>
                    clause.tag === tag ? { ...clause, join } : clause,
                ),
            },
        });
    },

    clearFilters: (): void => {
        set({ tagFilter: emptyTagFilter() });
    },

    ensureTagType: (typeName: string): void => {
        const normalized = normalizeTagTypeName(typeName);
        if (!normalized || isReservedTag(normalized)) {
            return;
        }
        const { tagTypes } = get();
        if (tagTypes.includes(normalized)) {
            return;
        }
        const nextTypes = [...tagTypes, normalized];
        set({ tagTypes: nextTypes });
        persistTagTypesConfig(nextTypes, get().tagTypeByName);
    },

    setTagType: (tagName: string, typeName: string): void => {
        const normalizedTag = normalizeTagTypeName(tagName);
        const normalizedType = normalizeTagTypeName(typeName);
        if (!normalizedTag || !normalizedType || isReservedTag(normalizedTag)) {
            return;
        }
        get().ensureTagType(normalizedType);
        const tagTypeByName = new Map(get().tagTypeByName);
        tagTypeByName.set(normalizedTag, normalizedType);
        set({ tagTypeByName });
        persistTagTypesConfig(get().tagTypes, tagTypeByName);
    },

    applyFileTags: (fileId: number, tags: string[]): void => {
        const fileIdsByTag = new Map(get().fileIdsByTag);
        removeFileFromIndex(fileIdsByTag, fileId);
        for (const tag of tags) {
            const ids = fileIdsByTag.get(tag) ?? new Set<number>();
            ids.add(fileId);
            fileIdsByTag.set(tag, ids);
        }
        const tagList = [...fileIdsByTag.keys()].sort();
        set({ tags: tagList, fileIdsByTag });
        persistCurrentIndex(tagList, fileIdsByTag);
    },

    applyTagRename: (oldName: string, newName: string): void => {
        const fileIdsByTag = new Map(get().fileIdsByTag);
        const oldIds = fileIdsByTag.get(oldName);
        if (!oldIds) {
            return;
        }
        fileIdsByTag.delete(oldName);
        const existing = fileIdsByTag.get(newName) ?? new Set<number>();
        fileIdsByTag.set(newName, new Set([...existing, ...oldIds]));
        const tagList = [...fileIdsByTag.keys()].sort();
        const tagFilter = get().tagFilter;
        const clauses = tagFilter.clauses.map((clause) => (
            clause.tag === oldName ? { ...clause, tag: newName } : clause
        ));
        const tagTypeByName = new Map(get().tagTypeByName);
        const oldType = tagTypeByName.get(oldName);
        if (oldType) {
            tagTypeByName.delete(oldName);
            if (!tagTypeByName.has(newName)) {
                tagTypeByName.set(newName, oldType);
            }
        }
        set({
            tags: tagList,
            fileIdsByTag,
            tagTypeByName,
            tagFilter: isTagFilterActive(tagFilter) ?
                { ...tagFilter, clauses } :
                tagFilter,
        });
        persistCurrentIndex(tagList, fileIdsByTag);
        persistTagTypesConfig(get().tagTypes, tagTypeByName);
    },

    applyTagDelete: (tagName: string): void => {
        const fileIdsByTag = new Map(get().fileIdsByTag);
        fileIdsByTag.delete(tagName);
        const tagList = [...fileIdsByTag.keys()].sort();
        const tagFilter = withoutTagClause(get().tagFilter, tagName);
        const tagTypeByName = new Map(get().tagTypeByName);
        tagTypeByName.delete(tagName);
        set({ tags: tagList, fileIdsByTag, tagFilter, tagTypeByName });
        persistCurrentIndex(tagList, fileIdsByTag);
        persistTagTypesConfig(get().tagTypes, tagTypeByName);
    },

    applyTagMerge: (sourceNames: string[], targetName: string): void => {
        const fileIdsByTag = new Map(get().fileIdsByTag);
        const merged = new Set(fileIdsByTag.get(targetName) ?? []);
        for (const source of sourceNames) {
            const ids = fileIdsByTag.get(source);
            if (ids) {
                for (const id of ids) {
                    merged.add(id);
                }
                fileIdsByTag.delete(source);
            }
        }
        if (merged.size > 0) {
            fileIdsByTag.set(targetName, merged);
        }
        const tagList = [...fileIdsByTag.keys()].sort();
        let tagFilter = get().tagFilter;
        const tagTypeByName = new Map(get().tagTypeByName);
        const mergedType = mergeTypeForTarget(
            targetName,
            sourceNames,
            tagTypeByName,
        );
        for (const source of sourceNames) {
            tagFilter = withoutTagClause(tagFilter, source);
            tagTypeByName.delete(source);
        }
        if (mergedType && !tagTypeByName.has(targetName)) {
            tagTypeByName.set(targetName, mergedType);
        }
        set({ tags: tagList, fileIdsByTag, tagFilter, tagTypeByName });
        persistCurrentIndex(tagList, fileIdsByTag);
        persistTagTypesConfig(get().tagTypes, tagTypeByName);
    },

    reset: (): void => {
        set({
            ...initialTagState,
            tagTypes: [DEFAULT_TAG_TYPE],
            tagTypeByName: new Map(),
        });
    },
});

export const useTagStore = create<TagState>(createTagStore);
