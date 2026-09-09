export const DEFAULT_TAG_TYPE = "default";

export const ALL_TAG_TYPES_TAB = "all";

export interface PersistedTagTypeConfig {
    types: string[];
    tagTypeByName: Record<string, string>;
    /**
     * Tags opted into kit nearness. Absent or false = excluded (default).
     * Sparse on disk: only `true` entries need be stored.
     */
    includeInKitNearnessByName?: Record<string, boolean>;
    /**
     * Tags that count toward the tagged/untagged presence filter.
     * Absent or true = included (default). Sparse on disk: only `false`
     * entries need be stored.
     */
    includeInEffectsPresenceByName?: Record<string, boolean>;
}

export const emptyTagTypeConfig = (): PersistedTagTypeConfig => ({
    types: [DEFAULT_TAG_TYPE],
    tagTypeByName: {},
});

/**
 * Trim whitespace and reject empty type names.
 */
export const normalizeTagTypeName = (name: string): string | undefined => {
    const trimmed = name.trim();
    if (!trimmed) {
        return undefined;
    }
    return trimmed;
};

export const configFromPersisted = (
    config: PersistedTagTypeConfig | undefined,
): {
    types: string[];
    tagTypeByName: Map<string, string>;
    includeInKitNearnessByName: Map<string, boolean>;
    includeInEffectsPresenceByName: Map<string, boolean>;
} => {
    const base = config ?? emptyTagTypeConfig();
    const types = base.types.includes(DEFAULT_TAG_TYPE) ?
        base.types :
        [DEFAULT_TAG_TYPE, ...base.types];
    const includeInKitNearnessByName = new Map<string, boolean>();
    for (const [name, value] of Object.entries(
        base.includeInKitNearnessByName ?? {},
    )) {
        if (value) {
            includeInKitNearnessByName.set(name, true);
        }
    }
    const includeInEffectsPresenceByName = new Map<string, boolean>();
    for (const [name, value] of Object.entries(
        base.includeInEffectsPresenceByName ?? {},
    )) {
        if (value === false) {
            includeInEffectsPresenceByName.set(name, false);
        }
    }
    return {
        types,
        tagTypeByName: new Map(Object.entries(base.tagTypeByName)),
        includeInKitNearnessByName,
        includeInEffectsPresenceByName,
    };
};

export const configToPersisted = (
    types: string[],
    tagTypeByName: Map<string, string>,
    includeInKitNearnessByName: Map<string, boolean> = new Map(),
    includeInEffectsPresenceByName: Map<string, boolean> = new Map(),
): PersistedTagTypeConfig => {
    const includeEntries: Record<string, boolean> = {};
    for (const [name, value] of includeInKitNearnessByName) {
        if (value) {
            includeEntries[name] = true;
        }
    }
    const effectsPresenceEntries: Record<string, boolean> = {};
    for (const [name, value] of includeInEffectsPresenceByName) {
        if (value === false) {
            effectsPresenceEntries[name] = false;
        }
    }
    const persisted: PersistedTagTypeConfig = {
        types,
        tagTypeByName: Object.fromEntries(tagTypeByName),
    };
    if (Object.keys(includeEntries).length > 0) {
        persisted.includeInKitNearnessByName = includeEntries;
    }
    if (Object.keys(effectsPresenceEntries).length > 0) {
        persisted.includeInEffectsPresenceByName = effectsPresenceEntries;
    }
    return persisted;
};

export const typeForTag = (
    tagName: string,
    tagTypeByName: Map<string, string>,
): string => tagTypeByName.get(tagName) ?? DEFAULT_TAG_TYPE;

/**
 * Whether the tag participates in kit nearness (default false).
 */
export const isTagIncludedInKitNearness = (
    tagName: string,
    includeInKitNearnessByName: ReadonlyMap<string, boolean>,
): boolean => includeInKitNearnessByName.get(tagName) === true;

/**
 * True when every tag is opted into kit nearness (empty list → false).
 */
export const areAllTagsIncludedInKitNearness = (
    tags: readonly string[],
    includeInKitNearnessByName: ReadonlyMap<string, boolean>,
): boolean =>
    tags.length > 0 &&
    tags.every((tag) =>
        isTagIncludedInKitNearness(tag, includeInKitNearnessByName));

/**
 * Keep only tags opted into kit nearness (order preserved).
 */
export const filterKitNearnessTags = (
    tags: readonly string[],
    includeInKitNearnessByName: ReadonlyMap<string, boolean>,
): string[] =>
    tags.filter((tag) =>
        isTagIncludedInKitNearness(tag, includeInKitNearnessByName));

/**
 * Whether the tag counts toward tagged/untagged presence (default true).
 */
export const isTagIncludedInEffectsPresence = (
    tagName: string,
    includeInEffectsPresenceByName: ReadonlyMap<string, boolean>,
): boolean => includeInEffectsPresenceByName.get(tagName) !== false;

export const orderedTypeTabs = (types: string[]): string[] => [
    ALL_TAG_TYPES_TAB,
    ...types,
];

/**
 * Sort tags by how many files use them (descending), then alphabetically.
 */
export const sortTagsByUsage = (
    tags: string[],
    fileIdsByTag: Map<string, Set<number>>,
): string[] =>
    [...tags].sort((a, b) => {
        const diff =
            (fileIdsByTag.get(b)?.size ?? 0) -
            (fileIdsByTag.get(a)?.size ?? 0);
        if (diff !== 0) {
            return diff;
        }
        return a.localeCompare(b);
    });

export const tagsForTypeView = (
    tags: string[],
    tagTypeByName: Map<string, string>,
    selectedType: string,
    fileIdsByTag: Map<string, Set<number>>,
): string[] => {
    const userTags = tags.filter((tag) => tag.length > 0);
    const filtered =
        selectedType === ALL_TAG_TYPES_TAB ?
            userTags :
            userTags.filter(
                (tag) => typeForTag(tag, tagTypeByName) === selectedType,
            );
    return sortTagsByUsage(filtered, fileIdsByTag);
};

export const tagsGroupedByType = (
    tags: string[],
    types: string[],
    tagTypeByName: Map<string, string>,
    fileIdsByTag: Map<string, Set<number>>,
): { type: string; tags: string[] }[] => {
    const buckets = new Map<string, string[]>();
    for (const type of types) {
        buckets.set(type, []);
    }
    for (const tag of tags) {
        const type = typeForTag(tag, tagTypeByName);
        const list = buckets.get(type) ?? [];
        list.push(tag);
        buckets.set(type, list);
    }
    return types
        .map((type) => ({
            type,
            tags: sortTagsByUsage(buckets.get(type) ?? [], fileIdsByTag),
        }))
        .filter((group) => group.tags.length > 0);
};
