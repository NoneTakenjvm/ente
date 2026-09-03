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
    createEmptyTagFilterRoot,
    emptyTagFilter,
    isTagFilterActive,
    isTagFilterClause,
    isTagFilterGroup,
    isReservedTag,
    newTagFilterNodeId,
    tagIndexToMaps,
    type TagFilterGroup,
    type TagFilterJoin,
    type TagFilterMode,
    type TagFilterNode,
    type TagFilterSelection,
    type TagScope,
    type CroppedScope,
    type FavoritesScope,
    type MediaScope,
} from "@/lib/tags";
import { normalizeTagName } from "@/lib/tag-writes";
import {
    setClauseInGroupOnFilter,
    setClauseModeOnFilter,
    setKitTagsInGroupOnFilter,
    setKitTagsModeOnFilter,
} from "@/lib/tag-filter-mutations";

import type { EnteFile } from "ente-media/file";

interface TagState {
    tags: string[];
    fileIdsByTag: Map<string, Set<number>>;
    registeredTagNames: string[];
    tagTypes: string[];
    tagTypeByName: Map<string, string>;
    tagFilter: TagFilterSelection;
    hydrateFromPersisted: (index: PersistedTagIndex) => void;
    hydrateTagTypes: (config: PersistedTagTypeConfig | undefined) => void;
    hydrateRegisteredTags: (names: string[] | undefined) => void;
    rebuildFromFiles: (files: EnteFile[]) => void;
    setTagScope: (scope: TagScope) => void;
    setFavoritesScope: (favoritesScope: FavoritesScope) => void;
    setMediaScope: (mediaScope: MediaScope) => void;
    setCroppedScope: (croppedScope: CroppedScope) => void;
    setTagFilterMode: (tag: string, mode: TagFilterMode | null) => void;
    setClauseMode: (clauseId: string, mode: TagFilterMode) => void;
    setClauseInGroup: (
        groupId: string,
        tag: string,
        mode: TagFilterMode | null,
    ) => void;
    setKitTagsMode: (tags: string[], mode: TagFilterMode | null) => void;
    setKitTagsInGroup: (
        groupId: string,
        tags: string[],
        mode: TagFilterMode | null,
    ) => void;
    setGroupOp: (groupId: string, op: TagFilterJoin) => void;
    wrapInGroup: (nodeIds: string[], op: TagFilterJoin) => void;
    ungroup: (groupId: string) => void;
    removeNode: (nodeId: string) => void;
    clearFilters: () => void;
    ensureTagType: (typeName: string) => void;
    setTagType: (tagName: string, typeName: string) => void;
    registerTag: (tagName: string, typeName?: string) => string | undefined;
    applyFileTags: (fileId: number, tags: string[]) => void;
    applyTagRename: (oldName: string, newName: string) => void;
    applyTagDelete: (tagName: string) => void;
    applyTagMerge: (sourceNames: string[], targetName: string) => void;
    reset: () => void;
}

const initialTypeState = configFromPersisted(undefined);

const initialTagState: Pick<
    TagState,
    "tags" | "fileIdsByTag" | "registeredTagNames" | "tagTypes" | "tagTypeByName" | "tagFilter"
> = {
    tags: [],
    fileIdsByTag: new Map(),
    registeredTagNames: [],
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

const persistRegisteredTags = (registeredTagNames: string[]): void => {
    enqueueOrganizerConfigPatch({
        registeredTags: registeredTagNames,
    });
};

const mergeRegisteredTagsIntoIndex = (
    tags: string[],
    fileIdsByTag: Map<string, Set<number>>,
    registeredTagNames: string[],
): { tags: string[]; fileIdsByTag: Map<string, Set<number>> } => {
    const nextFileIdsByTag = new Map(fileIdsByTag);
    const tagSet = new Set(tags);
    for (const name of registeredTagNames) {
        if (tagSet.has(name)) {
            continue;
        }
        tagSet.add(name);
        nextFileIdsByTag.set(name, new Set());
    }
    return {
        tags: [...tagSet].sort(),
        fileIdsByTag: nextFileIdsByTag,
    };
};

const dropRegisteredTagsWithFiles = (
    registeredTagNames: string[],
    fileIdsByTag: Map<string, Set<number>>,
    tagNames: Iterable<string>,
): string[] => {
    const next = new Set(registeredTagNames);
    for (const tag of tagNames) {
        if ((fileIdsByTag.get(tag)?.size ?? 0) > 0) {
            next.delete(tag);
        }
    }
    return [...next].sort();
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

const removeClauseByTagFromRoot = (
    root: TagFilterGroup,
    tag: string,
): TagFilterGroup => ({
    ...root,
    children: root.children.filter(
        (child) => !(isTagFilterClause(child) && child.tag === tag),
    ),
});

const removeNodeFromTree = (
    root: TagFilterGroup,
    nodeId: string,
): TagFilterGroup => ({
    ...root,
    children: root.children
        .filter((child) => child.id !== nodeId)
        .map((child) => {
            if (!isTagFilterGroup(child)) {
                return child;
            }
            return removeNodeFromTree(child, nodeId);
        }),
});

const updateGroupOp = (
    root: TagFilterGroup,
    groupId: string,
    op: TagFilterJoin,
): TagFilterGroup => {
    if (root.id === groupId) {
        return { ...root, op };
    }
    return {
        ...root,
        children: root.children.map((child) => {
            if (!isTagFilterGroup(child)) {
                return child;
            }
            return updateGroupOp(child, groupId, op);
        }),
    };
};

const findParentGroup = (
    root: TagFilterGroup,
    nodeId: string,
): TagFilterGroup | undefined => {
    for (const child of root.children) {
        if (child.id === nodeId) {
            return root;
        }
        if (isTagFilterGroup(child)) {
            const found = findParentGroup(child, nodeId);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
};

const ungroupNode = (
    root: TagFilterGroup,
    groupId: string,
): TagFilterGroup => {
    if (root.id === groupId) {
        return root;
    }

    const childIndex = root.children.findIndex(
        (child) => isTagFilterGroup(child) && child.id === groupId,
    );
    if (childIndex >= 0) {
        const group = root.children[childIndex] as TagFilterGroup;
        const nextChildren = [
            ...root.children.slice(0, childIndex),
            ...group.children,
            ...root.children.slice(childIndex + 1),
        ];
        return { ...root, children: nextChildren };
    }

    return {
        ...root,
        children: root.children.map((child) => {
            if (!isTagFilterGroup(child)) {
                return child;
            }
            return ungroupNode(child, groupId);
        }),
    };
};

const wrapSiblingsInGroup = (
    root: TagFilterGroup,
    nodeIds: string[],
    op: TagFilterJoin,
    parentId: string,
): TagFilterGroup => {
    if (root.id === parentId) {
        const idSet = new Set(nodeIds);
        const selected: TagFilterNode[] = [];
        for (const child of root.children) {
            if (idSet.has(child.id)) {
                selected.push(child);
            }
        }
        if (selected.length < 2) {
            return root;
        }
        const newGroup: TagFilterGroup = {
            kind: "group",
            id: newTagFilterNodeId(),
            op,
            children: selected,
        };
        const nextChildren: TagFilterNode[] = [];
        let grouped = false;
        for (const child of root.children) {
            if (!grouped && idSet.has(child.id)) {
                nextChildren.push(newGroup);
                grouped = true;
                continue;
            }
            if (!idSet.has(child.id)) {
                nextChildren.push(child);
            }
        }
        return { ...root, children: nextChildren };
    }

    return {
        ...root,
        children: root.children.map((child) => {
            if (!isTagFilterGroup(child)) {
                return child;
            }
            return wrapSiblingsInGroup(child, nodeIds, op, parentId);
        }),
    };
};

const renameTagInTree = (
    root: TagFilterGroup,
    oldName: string,
    newName: string,
): TagFilterGroup => ({
    ...root,
    children: root.children.map((child) => {
        if (isTagFilterClause(child)) {
            return child.tag === oldName ?
                { ...child, tag: newName } :
                child;
        }
        return renameTagInTree(child, oldName, newName);
    }),
});

const removeTagFromTree = (
    root: TagFilterGroup,
    tagName: string,
): TagFilterGroup => ({
    ...root,
    children: root.children
        .filter(
            (child) => !(isTagFilterClause(child) && child.tag === tagName),
        )
        .map((child) => {
            if (!isTagFilterGroup(child)) {
                return child;
            }
            return removeTagFromTree(child, tagName);
        }),
});

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

    hydrateRegisteredTags: (names: string[] | undefined): void => {
        const registeredTagNames = [...(names ?? [])].sort();
        const { tags, fileIdsByTag } = mergeRegisteredTagsIntoIndex(
            get().tags,
            get().fileIdsByTag,
            registeredTagNames,
        );
        set({ registeredTagNames, tags, fileIdsByTag });
    },

    rebuildFromFiles: (files: EnteFile[]): void => {
        const index = buildTagIndex(files);
        const { tags, fileIdsByTag } = tagIndexToMaps(index);
        const registeredTagNames = dropRegisteredTagsWithFiles(
            get().registeredTagNames,
            fileIdsByTag,
            tags,
        );
        const merged = mergeRegisteredTagsIntoIndex(
            tags,
            fileIdsByTag,
            registeredTagNames,
        );
        if (registeredTagNames.length !== get().registeredTagNames.length) {
            persistRegisteredTags(registeredTagNames);
        }
        set({
            tags: merged.tags,
            fileIdsByTag: merged.fileIdsByTag,
            registeredTagNames,
        });
        persistCurrentIndex(merged.tags, merged.fileIdsByTag);
    },

    setTagScope: (scope: TagScope): void => {
        const { tagFilter } = get();
        set({
            tagFilter: {
                ...tagFilter,
                tagScope: scope,
                root: scope === "untagged" ?
                    createEmptyTagFilterRoot() :
                    tagFilter.root,
            },
        });
    },

    setFavoritesScope: (favoritesScope: FavoritesScope): void => {
        const { tagFilter } = get();
        set({
            tagFilter: {
                ...tagFilter,
                favoritesScope,
            },
        });
    },

    setMediaScope: (mediaScope: MediaScope): void => {
        const { tagFilter } = get();
        set({
            tagFilter: {
                ...tagFilter,
                mediaScope,
            },
        });
    },

    setCroppedScope: (croppedScope: CroppedScope): void => {
        const { tagFilter } = get();
        set({
            tagFilter: {
                ...tagFilter,
                croppedScope,
            },
        });
    },

    setTagFilterMode: (tag: string, mode: TagFilterMode | null): void => {
        const { tagFilter } = get();
        const withoutTag = removeClauseByTagFromRoot(tagFilter.root, tag);
        if (mode === null) {
            set({
                tagFilter: {
                    ...tagFilter,
                    tagScope: tagFilter.tagScope === "untagged" ?
                        "all" :
                        tagFilter.tagScope,
                    root: withoutTag,
                },
            });
            return;
        }
        const clause = {
            kind: "clause" as const,
            id: newTagFilterNodeId(),
            tag,
            mode,
        };
        set({
            tagFilter: {
                ...tagFilter,
                tagScope: tagFilter.tagScope === "untagged" ?
                    "all" :
                    tagFilter.tagScope,
                root: {
                    ...withoutTag,
                    children: [...withoutTag.children, clause],
                },
            },
        });
    },

    setClauseMode: (clauseId: string, mode: TagFilterMode): void => {
        set({
            tagFilter: setClauseModeOnFilter(get().tagFilter, clauseId, mode),
        });
    },

    setClauseInGroup: (
        groupId: string,
        tag: string,
        mode: TagFilterMode | null,
    ): void => {
        set({
            tagFilter: setClauseInGroupOnFilter(
                get().tagFilter,
                groupId,
                tag,
                mode,
            ),
        });
    },

    setKitTagsMode: (tags: string[], mode: TagFilterMode | null): void => {
        set({
            tagFilter: setKitTagsModeOnFilter(get().tagFilter, tags, mode),
        });
    },

    setKitTagsInGroup: (
        groupId: string,
        tags: string[],
        mode: TagFilterMode | null,
    ): void => {
        set({
            tagFilter: setKitTagsInGroupOnFilter(
                get().tagFilter,
                groupId,
                tags,
                mode,
            ),
        });
    },

    setGroupOp: (groupId: string, op: TagFilterJoin): void => {
        const { tagFilter } = get();
        set({
            tagFilter: {
                ...tagFilter,
                root: updateGroupOp(tagFilter.root, groupId, op),
            },
        });
    },

    wrapInGroup: (nodeIds: string[], op: TagFilterJoin): void => {
        if (nodeIds.length < 2) {
            return;
        }
        const { tagFilter } = get();
        const parent = findParentGroup(tagFilter.root, nodeIds[0]);
        if (!parent) {
            return;
        }
        const allSameParent = nodeIds.every((id) => {
            const nodeParent = findParentGroup(tagFilter.root, id);
            return nodeParent?.id === parent.id;
        });
        if (!allSameParent) {
            return;
        }
        set({
            tagFilter: {
                ...tagFilter,
                root: wrapSiblingsInGroup(
                    tagFilter.root,
                    nodeIds,
                    op,
                    parent.id,
                ),
            },
        });
    },

    ungroup: (groupId: string): void => {
        const { tagFilter } = get();
        if (tagFilter.root.id === groupId) {
            return;
        }
        set({
            tagFilter: {
                ...tagFilter,
                root: ungroupNode(tagFilter.root, groupId),
            },
        });
    },

    removeNode: (nodeId: string): void => {
        const { tagFilter } = get();
        if (tagFilter.root.id === nodeId) {
            return;
        }
        set({
            tagFilter: {
                ...tagFilter,
                root: removeNodeFromTree(tagFilter.root, nodeId),
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
        const normalizedTag = normalizeTagName(tagName);
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

    registerTag: (tagName: string, typeName?: string): string | undefined => {
        const name = normalizeTagName(tagName);
        if (!name || isReservedTag(name)) {
            return undefined;
        }
        const { tags, fileIdsByTag, registeredTagNames } = get();
        if (tags.includes(name)) {
            return undefined;
        }
        const type =
            normalizeTagTypeName(typeName ?? "") ?? DEFAULT_TAG_TYPE;
        get().ensureTagType(type);
        get().setTagType(name, type);
        const nextRegistered = [...registeredTagNames, name].sort();
        const fileIdsByTagNext = new Map(fileIdsByTag);
        fileIdsByTagNext.set(name, new Set());
        const tagList = [...tags, name].sort();
        set({
            tags: tagList,
            fileIdsByTag: fileIdsByTagNext,
            registeredTagNames: nextRegistered,
        });
        persistCurrentIndex(tagList, fileIdsByTagNext);
        persistRegisteredTags(nextRegistered);
        return name;
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
        const registeredTagNames = dropRegisteredTagsWithFiles(
            get().registeredTagNames,
            fileIdsByTag,
            tags,
        );
        if (registeredTagNames.length !== get().registeredTagNames.length) {
            persistRegisteredTags(registeredTagNames);
        }
        set({ tags: tagList, fileIdsByTag, registeredTagNames });
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
        const tagTypeByName = new Map(get().tagTypeByName);
        const oldType = tagTypeByName.get(oldName);
        if (oldType) {
            tagTypeByName.delete(oldName);
            if (!tagTypeByName.has(newName)) {
                tagTypeByName.set(newName, oldType);
            }
        }
        const registeredTagNames = get().registeredTagNames
            .map((tag) => (tag === oldName ? newName : tag))
            .filter((tag, index, list) => list.indexOf(tag) === index)
            .sort();
        if (registeredTagNames.length !== get().registeredTagNames.length ||
            registeredTagNames.some(
                (tag, index) => tag !== get().registeredTagNames[index],
            )) {
            persistRegisteredTags(registeredTagNames);
        }
        set({
            tags: tagList,
            fileIdsByTag,
            tagTypeByName,
            registeredTagNames,
            tagFilter: isTagFilterActive(tagFilter) ?
                {
                    ...tagFilter,
                    root: renameTagInTree(tagFilter.root, oldName, newName),
                } :
                tagFilter,
        });
        persistCurrentIndex(tagList, fileIdsByTag);
        persistTagTypesConfig(get().tagTypes, tagTypeByName);
    },

    applyTagDelete: (tagName: string): void => {
        const fileIdsByTag = new Map(get().fileIdsByTag);
        fileIdsByTag.delete(tagName);
        const tagList = [...fileIdsByTag.keys()].sort();
        const registeredTagNames = get().registeredTagNames.filter(
            (tag) => tag !== tagName,
        );
        if (registeredTagNames.length !== get().registeredTagNames.length) {
            persistRegisteredTags(registeredTagNames);
        }
        const tagFilter = get().tagFilter;
        const tagTypeByName = new Map(get().tagTypeByName);
        tagTypeByName.delete(tagName);
        set({
            tags: tagList,
            fileIdsByTag,
            registeredTagNames,
            tagFilter: {
                ...tagFilter,
                root: removeTagFromTree(tagFilter.root, tagName),
            },
            tagTypeByName,
        });
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
            tagFilter = {
                ...tagFilter,
                root: removeTagFromTree(tagFilter.root, source),
            };
            tagTypeByName.delete(source);
        }
        if (mergedType && !tagTypeByName.has(targetName)) {
            tagTypeByName.set(targetName, mergedType);
        }
        let registeredTagNames = get().registeredTagNames.filter(
            (tag) => !sourceNames.includes(tag),
        );
        if (merged.size === 0 && !registeredTagNames.includes(targetName)) {
            registeredTagNames = [...registeredTagNames, targetName].sort();
        }
        if (merged.size > 0) {
            registeredTagNames = dropRegisteredTagsWithFiles(
                registeredTagNames,
                fileIdsByTag,
                [targetName],
            );
        }
        if (registeredTagNames.length !== get().registeredTagNames.length ||
            registeredTagNames.some(
                (tag, index) => tag !== get().registeredTagNames[index],
            )) {
            persistRegisteredTags(registeredTagNames);
        }
        const mergedIndex = mergeRegisteredTagsIntoIndex(
            tagList,
            fileIdsByTag,
            registeredTagNames,
        );
        set({
            tags: mergedIndex.tags,
            fileIdsByTag: mergedIndex.fileIdsByTag,
            registeredTagNames,
            tagFilter,
            tagTypeByName,
        });
        persistCurrentIndex(mergedIndex.tags, mergedIndex.fileIdsByTag);
        persistTagTypesConfig(get().tagTypes, tagTypeByName);
    },

    reset: (): void => {
        set({
            ...initialTagState,
            tagTypes: [DEFAULT_TAG_TYPE],
            tagTypeByName: new Map(),
            registeredTagNames: [],
        });
    },
});

export const useTagStore = create<TagState>(createTagStore);
