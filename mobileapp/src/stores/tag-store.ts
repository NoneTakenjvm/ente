import { create } from "zustand";
import type { StateCreator } from "zustand";
import type { PersistedTagIndex } from "@/db/kv";
import { saveKv } from "@/db/kv";
import { createDebouncedPersist } from "@/lib/debounced-persist";
import { registerFlush, registerReset } from "@/lib/session-lifecycle";
import { enqueueOrganizerConfigPatch } from "@/lib/organizer-config-save-queue";
import {
    configFromPersisted,
    configToPersisted,
    DEFAULT_TAG_TYPE,
    normalizeTagTypeName,
    type PersistedTagTypeConfig,
    type TagTypeConfig,
} from "@/lib/tag-types";
import {
    buildTagIndex,
    extractUserTags,
    isSystemTag,
    tagIndexToMaps,
} from "@/lib/tags";
import {
    emptyTagFilter,
    isTagFilterActive,
    isReservedTag,
    type TagFilterGroup,
    type TagFilterJoin,
    type TagFilterMode,
    type TagFilterSelection,
    type TagScope,
} from "@/lib/tag-filter";
import { normalizeTagName } from "@/lib/tag-writes";
import {
    removeTagFilterNode,
    removeTagFromTree,
    renameTagInTree,
    setClauseInGroupOnFilter,
    setClauseModeOnFilter,
    setKitInGroupOnFilter,
    setKitModeOnFilter,
    setTagFilterGroupOp,
    setTagFilterModeOnFilter,
    setTagFilterScope,
    setTagFilterScopes,
    ungroupTagFilterNode,
    wrapTagFilterNodesInGroup,
    type KitFilterInput,
    type TagFilterScopePatch,
} from "@/lib/tag-filter-mutations";

import type { EnteFile } from "ente-media/file";

/** Which tag filter slice gallery vs album view controls read and write. */
export type TagFilterTarget = "gallery" | "album";

interface TagState {
    tags: string[];
    fileIdsByTag: Map<string, Set<number>>;
    registeredTagNames: string[];
    typeConfig: TagTypeConfig;
    tagFilter: TagFilterSelection;
    /** Session overlay filter when refining an open album view. */
    albumViewFilter: TagFilterSelection;
    /**
     * File ids touched by the latest {@link applyFilesTags} call.
     * `undefined` means a full rebuild / structural rename — gallery must
     * refilter from scratch.
     */
    lastTagTouchFileIds: number[] | undefined;
    hydrateFromPersisted: (index: PersistedTagIndex) => void;
    hydrateTagTypes: (config: PersistedTagTypeConfig | undefined) => void;
    hydrateRegisteredTags: (names: string[] | undefined) => void;
    rebuildFromFiles: (files: EnteFile[]) => void;
    setTagScope: (scope: TagScope, target?: TagFilterTarget) => void;
    /** Set the favourites, media, crop or rotate scopes in one step. */
    patchFilter: (patch: TagFilterScopePatch, target?: TagFilterTarget) => void;
    setTagFilterMode: (
        tag: string,
        mode: TagFilterMode | null,
        target?: TagFilterTarget,
    ) => void;
    setClauseMode: (
        clauseId: string,
        mode: TagFilterMode,
        target?: TagFilterTarget,
    ) => void;
    setClauseInGroup: (
        groupId: string,
        tag: string,
        mode: TagFilterMode | null,
        target?: TagFilterTarget,
    ) => void;
    setKitMode: (
        kit: KitFilterInput,
        mode: TagFilterMode | null,
        target?: TagFilterTarget,
    ) => void;
    setKitInGroup: (
        groupId: string,
        kit: KitFilterInput,
        mode: TagFilterMode | null,
        target?: TagFilterTarget,
    ) => void;
    setGroupOp: (
        groupId: string,
        op: TagFilterJoin,
        target?: TagFilterTarget,
    ) => void;
    wrapInGroup: (
        nodeIds: string[],
        op: TagFilterJoin,
        target?: TagFilterTarget,
    ) => void;
    ungroup: (groupId: string, target?: TagFilterTarget) => void;
    removeNode: (nodeId: string, target?: TagFilterTarget) => void;
    clearFilters: (target?: TagFilterTarget) => void;
    clearAlbumViewFilter: () => void;
    ensureTagType: (typeName: string) => void;
    setTagType: (tagName: string, typeName: string) => void;
    setIncludeInKitNearness: (tagName: string, include: boolean) => void;
    setIncludeInEffectsPresence: (tagName: string, include: boolean) => void;
    registerTag: (tagName: string, typeName?: string) => string | undefined;
    applyFileTags: (fileId: number, tags: string[], previousTags?: string[]) => void;
    /** Update the tag index for many files in one store notify + persist. */
    applyFilesTags: (
        updates: Array<{
            fileId: number;
            tags: string[];
            previousTags?: string[];
        }>,
    ) => void;
    /**
     * Update the index when files leave or (re)enter the library (upload,
     * replace, prune, trash, restore) without rescanning every file. Persists
     * on the debounce, like {@link applyFilesTags}.
     */
    applyLibraryFilesChange: (change: {
        removedFileIds: Iterable<number>;
        addedFiles: readonly EnteFile[];
    }) => void;
    applyTagRename: (oldName: string, newName: string) => void;
    applyTagDelete: (tagName: string) => void;
    applyTagMerge: (sourceNames: string[], targetName: string) => void;
    reset: () => void;
}

const initialTagState: Pick<
    TagState,
    "tags" |
    "fileIdsByTag" |
    "registeredTagNames" |
    "typeConfig" |
    "tagFilter" |
    "albumViewFilter" |
    "lastTagTouchFileIds"
> = {
    tags: [],
    fileIdsByTag: new Map(),
    registeredTagNames: [],
    typeConfig: configFromPersisted(undefined),
    tagFilter: emptyTagFilter(),
    albumViewFilter: emptyTagFilter(),
    lastTagTouchFileIds: undefined,
};

const filterForTarget = (
    state: TagState,
    target: TagFilterTarget,
): TagFilterSelection =>
    target === "gallery" ? state.tagFilter : state.albumViewFilter;

const patchFilterForTarget = (
    target: TagFilterTarget,
    filter: TagFilterSelection,
): Partial<Pick<TagState, "tagFilter" | "albumViewFilter">> =>
    target === "gallery" ?
        { tagFilter: filter } :
        { albumViewFilter: filter };

const updateTagFilter = (
    set: (partial: Partial<TagState>) => void,
    get: () => TagState,
    target: TagFilterTarget,
    update: (filter: TagFilterSelection) => TagFilterSelection,
): void => {
    set(patchFilterForTarget(target, update(filterForTarget(get(), target))));
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

const TAG_INDEX_SAVE_DEBOUNCE_MS = 1500;

interface TagIndexSnapshot {
    tags: string[];
    fileIdsByTag: Map<string, Set<number>>;
}

/** Latest snapshot wins; it is serialized only when the write runs. */
const tagIndexSaver = createDebouncedPersist(
    async ({ tags, fileIdsByTag }: TagIndexSnapshot): Promise<void> => {
        try {
            await saveKv("tagIndex", indexFromMaps(tags, fileIdsByTag));
        } catch (error) {
            console.warn("Tag index persist failed", error);
        }
    },
    TAG_INDEX_SAVE_DEBOUNCE_MS,
);

registerFlush(tagIndexSaver.flush);

/** Immediate encrypt+IDB write (rebuild / structural renames). */
const persistCurrentIndexNow = (
    tags: string[],
    fileIdsByTag: Map<string, Set<number>>,
): void => {
    tagIndexSaver.schedule({ tags, fileIdsByTag });
    void tagIndexSaver.flush();
};

/**
 * Trailing-debounce tag-index encrypt so per-file tag commits stay snappy.
 * Latest snapshot wins; flushed on page hide.
 */
const schedulePersistCurrentIndex = (
    tags: string[],
    fileIdsByTag: Map<string, Set<number>>,
): void => {
    tagIndexSaver.schedule({ tags, fileIdsByTag });
};

/**
 * Return a bucket for `tag` that is safe to mutate in place.
 *
 * [Note: Tag bucket copy-on-write] The working `fileIdsByTag` Map is a fresh
 * copy per store action, but its Sets are shared with the previous state that
 * React subscribers may still hold. Clone each touched bucket once per action
 * (tracked in `ownedTags`) and mutate that clone for every later file.
 */
const ownedBucket = (
    fileIdsByTag: Map<string, Set<number>>,
    ownedTags: Set<string>,
    tag: string,
): Set<number> => {
    const bucket = fileIdsByTag.get(tag);
    if (bucket && ownedTags.has(tag)) {
        return bucket;
    }
    const owned = new Set(bucket);
    fileIdsByTag.set(tag, owned);
    ownedTags.add(tag);
    return owned;
};

/**
 * Move one file between tag buckets without scanning every tag in the library.
 * System tags are ignored — they must not affect tagged/untagged presence.
 *
 * @param ownedTags buckets already cloned in this action (see
 * {@link ownedBucket})
 * @returns true when a tag key was added or removed from the index
 */
const applyIncrementalFileTags = (
    fileIdsByTag: Map<string, Set<number>>,
    ownedTags: Set<string>,
    fileId: number,
    previousTags: readonly string[],
    newTags: readonly string[],
): boolean => {
    let tagKeysChanged = false;
    const previous = new Set(
        previousTags.filter((tag) => !isSystemTag(tag)),
    );
    const next = new Set(newTags.filter((tag) => !isSystemTag(tag)));

    for (const tag of previous) {
        if (next.has(tag)) {
            continue;
        }
        const bucket = fileIdsByTag.get(tag);
        if (!bucket?.has(fileId)) {
            continue;
        }
        if (bucket.size === 1) {
            fileIdsByTag.delete(tag);
            tagKeysChanged = true;
        } else {
            ownedBucket(fileIdsByTag, ownedTags, tag).delete(fileId);
        }
    }

    for (const tag of next) {
        if (previous.has(tag)) {
            continue;
        }
        if (!fileIdsByTag.has(tag)) {
            tagKeysChanged = true;
        }
        ownedBucket(fileIdsByTag, ownedTags, tag).add(fileId);
    }

    return tagKeysChanged;
};

/** Drop system-tag buckets left by older builds that indexed them. */
const scrubSystemTagsFromIndex = (
    fileIdsByTag: Map<string, Set<number>>,
): boolean => {
    let changed = false;
    for (const tag of [...fileIdsByTag.keys()]) {
        if (!isSystemTag(tag)) {
            continue;
        }
        fileIdsByTag.delete(tag);
        changed = true;
    }
    return changed;
};

/** Publish a new type config and queue its cloud write. */
const commitTypeConfig = (
    set: (partial: Partial<TagState>) => void,
    typeConfig: TagTypeConfig,
    alsoSet: Partial<TagState> = {},
): void => {
    set({ ...alsoSet, typeConfig });
    enqueueOrganizerConfigPatch({
        tagTypes: configToPersisted(
            typeConfig.types,
            typeConfig.tagTypeByName,
            typeConfig.includeInKitNearnessByName,
            typeConfig.includeInEffectsPresenceByName,
        ),
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

/**
 * Publish an incrementally edited index: refresh the tag list when keys
 * changed, retire registered names that now have files, and schedule the
 * debounced persist.
 */
const commitIncrementalIndex = (
    set: (partial: Partial<TagState>) => void,
    get: () => TagState,
    fileIdsByTag: Map<string, Set<number>>,
    tagKeysChanged: boolean,
    touchedTagNames: string[],
    lastTagTouchFileIds: number[] | undefined,
): void => {
    const tagList = tagKeysChanged ?
        [...fileIdsByTag.keys()].sort() :
        get().tags;
    const registeredTagNames = dropRegisteredTagsWithFiles(
        get().registeredTagNames,
        fileIdsByTag,
        touchedTagNames,
    );
    if (registeredTagNames.length !== get().registeredTagNames.length) {
        persistRegisteredTags(registeredTagNames);
    }
    set({
        tags: tagList,
        fileIdsByTag,
        registeredTagNames,
        lastTagTouchFileIds,
    });
    schedulePersistCurrentIndex(tagList, fileIdsByTag);
};

/**
 * Drop many file ids from every tag bucket in one pass over the index.
 *
 * Only buckets that contain one of `fileIds` are cloned (once each); emptied
 * buckets are deleted.
 *
 * @returns true when a tag key was removed from the index
 */
const removeFilesFromIndex = (
    fileIdsByTag: Map<string, Set<number>>,
    ownedTags: Set<string>,
    fileIds: Set<number>,
): boolean => {
    let tagKeysChanged = false;
    if (fileIds.size === 0) {
        return false;
    }
    for (const [tag, ids] of fileIdsByTag) {
        let next: Set<number> | undefined;
        for (const fileId of fileIds) {
            if (!ids.has(fileId)) {
                continue;
            }
            next ??= ownedBucket(fileIdsByTag, ownedTags, tag);
            next.delete(fileId);
        }
        if (next?.size === 0) {
            fileIdsByTag.delete(tag);
            tagKeysChanged = true;
        }
    }
    return tagKeysChanged;
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

/**
 * Copy `typeConfig` with `sourceNames` removed and, when `targetName` is set,
 * their settings merged onto it: the target's type else the first source's,
 * kit nearness ORed across all involved tags, and effects presence included
 * if any involved tag is included.
 *
 * [Note: Effects-presence inheritance] Only exclusions (`false`) are stored. A
 * brand-new target does not count as an included tag, so merging or renaming
 * only excluded tags onto a new name keeps it excluded.
 */
const mergeTypeConfig = (
    typeConfig: TagTypeConfig,
    sourceNames: string[],
    targetName: string | undefined,
    targetExisted: boolean,
): TagTypeConfig => {
    const tagTypeByName = new Map(typeConfig.tagTypeByName);
    const includeInKitNearnessByName = new Map(
        typeConfig.includeInKitNearnessByName,
    );
    const includeInEffectsPresenceByName = new Map(
        typeConfig.includeInEffectsPresenceByName,
    );
    let mergedType: string | undefined;
    let mergedKit = false;
    let mergedEffects = false;
    if (targetName !== undefined) {
        mergedType = mergeTypeForTarget(targetName, sourceNames, tagTypeByName);
        mergedKit = [targetName, ...sourceNames].some(
            (name) => includeInKitNearnessByName.get(name) === true,
        );
        const effectsNames = new Set(sourceNames);
        if (targetExisted || includeInEffectsPresenceByName.has(targetName)) {
            effectsNames.add(targetName);
        }
        mergedEffects = [...effectsNames].some(
            (name) => includeInEffectsPresenceByName.get(name) !== false,
        );
    }
    for (const source of sourceNames) {
        tagTypeByName.delete(source);
        includeInKitNearnessByName.delete(source);
        includeInEffectsPresenceByName.delete(source);
    }
    if (targetName !== undefined) {
        if (mergedType && !tagTypeByName.has(targetName)) {
            tagTypeByName.set(targetName, mergedType);
        }
        if (mergedKit) {
            includeInKitNearnessByName.set(targetName, true);
        } else {
            includeInKitNearnessByName.delete(targetName);
        }
        if (mergedEffects) {
            includeInEffectsPresenceByName.delete(targetName);
        } else {
            includeInEffectsPresenceByName.set(targetName, false);
        }
    }
    return {
        ...typeConfig,
        tagTypeByName,
        includeInKitNearnessByName,
        includeInEffectsPresenceByName,
    };
};

/**
 * The one path behind rename, delete and merge: move `sourceNames` into
 * `targetName` (rename is a merge of one source; delete has no target), then
 * fix the type config, registered names and both filters, and persist.
 *
 * @param rewriteTree how one source name leaves a filter tree (rename it, or
 * remove its clauses)
 */
const applyTagRewrite = (
    set: (partial: Partial<TagState>) => void,
    get: () => TagState,
    sourceNames: string[],
    targetName: string | undefined,
    rewriteTree: (root: TagFilterGroup, source: string) => TagFilterGroup,
): void => {
    const state = get();
    const fileIdsByTag = new Map(state.fileIdsByTag);
    const targetExisted =
        targetName !== undefined &&
        (fileIdsByTag.has(targetName) || state.tags.includes(targetName));
    const mergedIds = new Set(
        targetName === undefined ? [] : fileIdsByTag.get(targetName),
    );
    for (const source of sourceNames) {
        for (const id of fileIdsByTag.get(source) ?? []) {
            mergedIds.add(id);
        }
        fileIdsByTag.delete(source);
    }
    if (targetName !== undefined && mergedIds.size > 0) {
        fileIdsByTag.set(targetName, mergedIds);
    }

    let registeredTagNames = state.registeredTagNames.filter(
        (tag) => !sourceNames.includes(tag),
    );
    if (targetName !== undefined) {
        if (mergedIds.size > 0) {
            registeredTagNames = dropRegisteredTagsWithFiles(
                registeredTagNames,
                fileIdsByTag,
                [targetName],
            );
        } else if (!registeredTagNames.includes(targetName)) {
            registeredTagNames = [...registeredTagNames, targetName].sort();
        }
    }
    if (
        registeredTagNames.length !== state.registeredTagNames.length ||
        registeredTagNames.some(
            (tag, index) => tag !== state.registeredTagNames[index],
        )
    ) {
        persistRegisteredTags(registeredTagNames);
    }

    const rewriteFilter = (filter: TagFilterSelection): TagFilterSelection =>
        isTagFilterActive(filter) ?
            { ...filter, root: sourceNames.reduce(rewriteTree, filter.root) } :
            filter;
    const index = mergeRegisteredTagsIntoIndex(
        [...fileIdsByTag.keys()].sort(),
        fileIdsByTag,
        registeredTagNames,
    );
    commitTypeConfig(
        set,
        mergeTypeConfig(state.typeConfig, sourceNames, targetName, targetExisted),
        {
            tags: index.tags,
            fileIdsByTag: index.fileIdsByTag,
            registeredTagNames,
            tagFilter: rewriteFilter(state.tagFilter),
            albumViewFilter: rewriteFilter(state.albumViewFilter),
            lastTagTouchFileIds: undefined,
        },
    );
    persistCurrentIndexNow(index.tags, index.fileIdsByTag);
};

const createTagStore: StateCreator<TagState> = (set, get) => ({
    ...initialTagState,

    hydrateFromPersisted: (index: PersistedTagIndex): void => {
        const { tags, fileIdsByTag } = tagIndexToMaps(index);
        const scrubbed = scrubSystemTagsFromIndex(fileIdsByTag);
        const tagList = scrubbed ?
            [...fileIdsByTag.keys()].sort() :
            tags.filter((tag) => !isSystemTag(tag));
        set({
            tags: tagList,
            fileIdsByTag,
            lastTagTouchFileIds: undefined,
        });
        if (scrubbed) {
            persistCurrentIndexNow(tagList, fileIdsByTag);
        }
    },

    hydrateTagTypes: (config: PersistedTagTypeConfig | undefined): void => {
        set({
            typeConfig: configFromPersisted(config),
            lastTagTouchFileIds: undefined,
        });
    },

    hydrateRegisteredTags: (names: string[] | undefined): void => {
        const registeredTagNames = [...(names ?? [])].sort();
        const { tags, fileIdsByTag } = mergeRegisteredTagsIntoIndex(
            get().tags,
            get().fileIdsByTag,
            registeredTagNames,
        );
        set({
            registeredTagNames,
            tags,
            fileIdsByTag,
            lastTagTouchFileIds: undefined,
        });
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
            lastTagTouchFileIds: undefined,
        });
        persistCurrentIndexNow(merged.tags, merged.fileIdsByTag);
    },

    setTagScope: (scope: TagScope, target: TagFilterTarget = "gallery"): void => {
        updateTagFilter(set, get, target, (tagFilter) =>
            setTagFilterScope(
                tagFilter,
                scope,
                get().typeConfig.includeInEffectsPresenceByName,
            ));
    },

    patchFilter: (
        patch: TagFilterScopePatch,
        target: TagFilterTarget = "gallery",
    ): void => {
        updateTagFilter(set, get, target, (tagFilter) =>
            setTagFilterScopes(tagFilter, patch));
    },

    setTagFilterMode: (
        tag: string,
        mode: TagFilterMode | null,
        target: TagFilterTarget = "gallery",
    ): void => {
        updateTagFilter(set, get, target, (tagFilter) =>
            setTagFilterModeOnFilter(
                tagFilter,
                tag,
                mode,
                get().typeConfig.includeInEffectsPresenceByName,
            ));
    },

    setClauseMode: (
        clauseId: string,
        mode: TagFilterMode,
        target: TagFilterTarget = "gallery",
    ): void => {
        updateTagFilter(set, get, target, (tagFilter) =>
            setClauseModeOnFilter(
                tagFilter,
                clauseId,
                mode,
                get().typeConfig.includeInEffectsPresenceByName,
            ));
    },

    setClauseInGroup: (
        groupId: string,
        tag: string,
        mode: TagFilterMode | null,
        target: TagFilterTarget = "gallery",
    ): void => {
        updateTagFilter(set, get, target, (tagFilter) =>
            setClauseInGroupOnFilter(
                tagFilter,
                groupId,
                tag,
                mode,
                get().typeConfig.includeInEffectsPresenceByName,
            ));
    },

    setKitMode: (
        kit: KitFilterInput,
        mode: TagFilterMode | null,
        target: TagFilterTarget = "gallery",
    ): void => {
        updateTagFilter(set, get, target, (tagFilter) =>
            setKitModeOnFilter(
                tagFilter,
                kit,
                mode,
                get().typeConfig.includeInEffectsPresenceByName,
            ));
    },

    setKitInGroup: (
        groupId: string,
        kit: KitFilterInput,
        mode: TagFilterMode | null,
        target: TagFilterTarget = "gallery",
    ): void => {
        updateTagFilter(set, get, target, (tagFilter) =>
            setKitInGroupOnFilter(
                tagFilter,
                groupId,
                kit,
                mode,
                get().typeConfig.includeInEffectsPresenceByName,
            ));
    },

    setGroupOp: (
        groupId: string,
        op: TagFilterJoin,
        target: TagFilterTarget = "gallery",
    ): void => {
        updateTagFilter(set, get, target, (tagFilter) =>
            setTagFilterGroupOp(tagFilter, groupId, op));
    },

    wrapInGroup: (
        nodeIds: string[],
        op: TagFilterJoin,
        target: TagFilterTarget = "gallery",
    ): void => {
        updateTagFilter(set, get, target, (tagFilter) =>
            wrapTagFilterNodesInGroup(tagFilter, nodeIds, op));
    },

    ungroup: (groupId: string, target: TagFilterTarget = "gallery"): void => {
        updateTagFilter(set, get, target, (tagFilter) =>
            ungroupTagFilterNode(tagFilter, groupId));
    },

    removeNode: (nodeId: string, target: TagFilterTarget = "gallery"): void => {
        updateTagFilter(set, get, target, (tagFilter) =>
            removeTagFilterNode(tagFilter, nodeId));
    },

    clearFilters: (target: TagFilterTarget = "gallery"): void => {
        set(patchFilterForTarget(target, emptyTagFilter()));
    },

    clearAlbumViewFilter: (): void => {
        set({ albumViewFilter: emptyTagFilter() });
    },

    ensureTagType: (typeName: string): void => {
        const normalized = normalizeTagTypeName(typeName);
        if (!normalized || isReservedTag(normalized)) {
            return;
        }
        const { typeConfig } = get();
        if (typeConfig.types.includes(normalized)) {
            return;
        }
        commitTypeConfig(set, {
            ...typeConfig,
            types: [...typeConfig.types, normalized],
        });
    },

    setTagType: (tagName: string, typeName: string): void => {
        const normalizedTag = normalizeTagName(tagName);
        const normalizedType = normalizeTagTypeName(typeName);
        if (!normalizedTag || !normalizedType || isReservedTag(normalizedTag)) {
            return;
        }
        get().ensureTagType(normalizedType);
        const { typeConfig } = get();
        const tagTypeByName = new Map(typeConfig.tagTypeByName);
        tagTypeByName.set(normalizedTag, normalizedType);
        commitTypeConfig(set, { ...typeConfig, tagTypeByName });
    },

    setIncludeInKitNearness: (tagName: string, include: boolean): void => {
        const normalizedTag = normalizeTagName(tagName);
        if (!normalizedTag || isReservedTag(normalizedTag)) {
            return;
        }
        const { typeConfig } = get();
        const includeInKitNearnessByName = new Map(
            typeConfig.includeInKitNearnessByName,
        );
        if (include) {
            includeInKitNearnessByName.set(normalizedTag, true);
        } else {
            includeInKitNearnessByName.delete(normalizedTag);
        }
        commitTypeConfig(set, { ...typeConfig, includeInKitNearnessByName });
    },

    setIncludeInEffectsPresence: (tagName: string, include: boolean): void => {
        const normalizedTag = normalizeTagName(tagName);
        if (!normalizedTag || isReservedTag(normalizedTag)) {
            return;
        }
        const { typeConfig } = get();
        const includeInEffectsPresenceByName = new Map(
            typeConfig.includeInEffectsPresenceByName,
        );
        if (include) {
            includeInEffectsPresenceByName.delete(normalizedTag);
        } else {
            includeInEffectsPresenceByName.set(normalizedTag, false);
        }
        // Full gallery refilter — presence changes can move many files in/out
        // of tagged/untagged, not just the last touched file.
        commitTypeConfig(
            set,
            { ...typeConfig, includeInEffectsPresenceByName },
            { lastTagTouchFileIds: undefined },
        );
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
            lastTagTouchFileIds: undefined,
        });
        persistCurrentIndexNow(tagList, fileIdsByTagNext);
        persistRegisteredTags(nextRegistered);
        return name;
    },

    applyFileTags: (fileId: number, tags: string[], previousTags?: string[]): void => {
        get().applyFilesTags([{ fileId, tags, previousTags }]);
    },

    applyFilesTags: (
        updates: Array<{
            fileId: number;
            tags: string[];
            previousTags?: string[];
        }>,
    ): void => {
        if (!updates.length) {
            return;
        }
        const fileIdsByTag = new Map(get().fileIdsByTag);
        const ownedTags = new Set<string>();
        const touchedTagNames = updates.flatMap(({ tags }) =>
            tags.filter((tag) => !isSystemTag(tag)));
        let tagKeysChanged = false;

        const canUseIncremental = updates.every(
            (update) => update.previousTags !== undefined,
        );

        if (canUseIncremental) {
            for (const { fileId, tags, previousTags } of updates) {
                if (applyIncrementalFileTags(
                    fileIdsByTag,
                    ownedTags,
                    fileId,
                    previousTags!,
                    tags,
                )) {
                    tagKeysChanged = true;
                }
            }
        } else {
            removeFilesFromIndex(
                fileIdsByTag,
                ownedTags,
                new Set(updates.map((update) => update.fileId)),
            );
            for (const { fileId, tags } of updates) {
                for (const tag of tags) {
                    if (isSystemTag(tag)) {
                        continue;
                    }
                    ownedBucket(fileIdsByTag, ownedTags, tag).add(fileId);
                }
            }
            tagKeysChanged = true;
        }

        if (scrubSystemTagsFromIndex(fileIdsByTag)) {
            tagKeysChanged = true;
        }

        commitIncrementalIndex(
            set,
            get,
            fileIdsByTag,
            tagKeysChanged,
            touchedTagNames,
            updates.map((update) => update.fileId),
        );
    },

    applyLibraryFilesChange: ({
        removedFileIds,
        addedFiles,
    }: {
        removedFileIds: Iterable<number>;
        addedFiles: readonly EnteFile[];
    }): void => {
        const fileIdsByTag = new Map(get().fileIdsByTag);
        const ownedTags = new Set<string>();
        // Added ids are dropped first so a replaced file loses its old tags.
        const removed = new Set(removedFileIds);
        for (const file of addedFiles) {
            removed.add(file.id);
        }
        let tagKeysChanged = removeFilesFromIndex(
            fileIdsByTag,
            ownedTags,
            removed,
        );
        const touchedTagNames: string[] = [];
        for (const file of addedFiles) {
            for (const tag of extractUserTags(file)) {
                if (!fileIdsByTag.has(tag)) {
                    tagKeysChanged = true;
                }
                ownedBucket(fileIdsByTag, ownedTags, tag).add(file.id);
                touchedTagNames.push(tag);
            }
        }
        if (ownedTags.size === 0) {
            // No bucket held or gained any of these files.
            return;
        }

        commitIncrementalIndex(
            set,
            get,
            fileIdsByTag,
            tagKeysChanged,
            touchedTagNames,
            undefined,
        );
    },

    applyTagRename: (oldName: string, newName: string): void => {
        if (!get().fileIdsByTag.has(oldName)) {
            return;
        }
        applyTagRewrite(set, get, [oldName], newName, (root, source) =>
            renameTagInTree(root, source, newName));
    },

    applyTagDelete: (tagName: string): void => {
        applyTagRewrite(set, get, [tagName], undefined, removeTagFromTree);
    },

    applyTagMerge: (sourceNames: string[], targetName: string): void => {
        applyTagRewrite(set, get, sourceNames, targetName, removeTagFromTree);
    },

    reset: (): void => {
        tagIndexSaver.cancel();
        set({
            ...initialTagState,
            typeConfig: configFromPersisted(undefined),
            registeredTagNames: [],
        });
    },
});

export const useTagStore = create<TagState>(createTagStore);

registerReset(() => {
    useTagStore.getState().reset();
});
