export const DEFAULT_TAG_TYPE = "default";

export const ALL_TAG_TYPES_TAB = "all";

export interface PersistedTagTypeConfig {
    types: string[];
    tagTypeByName: Record<string, string>;
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
} => {
    const base = config ?? emptyTagTypeConfig();
    const types = base.types.includes(DEFAULT_TAG_TYPE) ?
        base.types :
        [DEFAULT_TAG_TYPE, ...base.types];
    return {
        types,
        tagTypeByName: new Map(Object.entries(base.tagTypeByName)),
    };
};

export const configToPersisted = (
    types: string[],
    tagTypeByName: Map<string, string>,
): PersistedTagTypeConfig => ({
    types,
    tagTypeByName: Object.fromEntries(tagTypeByName),
});

export const typeForTag = (
    tagName: string,
    tagTypeByName: Map<string, string>,
): string => tagTypeByName.get(tagName) ?? DEFAULT_TAG_TYPE;

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
