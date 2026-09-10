import { normalizeTagName } from "@/lib/tag-writes";
import { setKitModeOnFilter } from "@/lib/tag-filter-mutations";
import {
    emptyTagFilter,
    extractUserTags,
    isFlatTagFilterRoot,
    isTagFilterActive,
    isTagFilterClause,
    isTagFilterKit,
    type TagFilterSelection,
} from "@/lib/tags";
import { areAllTagsIncludedInKitNearness } from "@/lib/tag-types";
import {
    parseKitNearnessTuneResult,
    type KitNearnessTuneResult,
} from "@/lib/kit-nearness-embedding-genome";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import type { EnteFile } from "ente-media/file";

export interface TagPreset {
    id: string;
    name: string;
    tags: string[];
    /** Optional per-kit CLIP nearness tune (only when it beats the global default). */
    nearnessTune?: KitNearnessTuneResult;
}

export type PersistedTagPresets = TagPreset[];

/** Tab id for the kits list in {@link TagPickerSheet}. */
export const KITS_TAB = "Kits";

/**
 * Create a stable preset id.
 */
export const newTagPresetId = (): string =>
    `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Normalize a preset name; empty after trim is rejected.
 */
export const normalizePresetName = (name: string): string | undefined => {
    const trimmed = name.trim();
    if (!trimmed) {
        return undefined;
    }
    return trimmed;
};

/**
 * Deduplicate and normalize tag names for a preset.
 */
export const normalizePresetTags = (tags: string[]): string[] => {
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
 * How many files already have every tag in the kit (extras allowed).
 * Archived files are ignored (long-term storage).
 */
export const countFilesMatchingKit = (
    files: EnteFile[],
    kitTags: string[],
): number => {
    if (!kitTags.length || !files.length) {
        return 0;
    }
    let matched = 0;
    for (const file of files) {
        if (isFileArchivedLocally(file)) {
            continue;
        }
        const have = new Set(extractUserTags(file));
        if (kitTags.every((tag) => have.has(tag))) {
            matched += 1;
        }
    }
    return matched;
};

/**
 * True when two tag lists are the same set (order-independent).
 */
export const tagSetsEqual = (left: readonly string[], right: readonly string[]): boolean => {
    if (left.length !== right.length) {
        return false;
    }
    const rightSet = new Set(right);
    return left.every((tag) => rightSet.has(tag));
};

/**
 * When a nearness filter is exactly one kit (flat AND includes, no scopes /
 * excludes), return that preset so competitive rival ranking can apply.
 * Otherwise `undefined` — use plain medoid min-distance (no rival penalty).
 */
export const matchNearnessFilterToKitPreset = (
    filter: TagFilterSelection,
    presets: readonly TagPreset[],
): TagPreset | undefined => {
    if (
        filter.tagScope !== "all" ||
        filter.favoritesScope !== "all" ||
        filter.mediaScope !== "all" ||
        filter.croppedScope !== "all"
    ) {
        return undefined;
    }
    if (!isFlatTagFilterRoot(filter.root)) {
        return undefined;
    }
    // Kit pick = AND of includes (extras allowed). OR / ONLY are different.
    if (filter.root.op !== "and") {
        return undefined;
    }
    if (
        filter.root.children.length === 1 &&
        isTagFilterKit(filter.root.children[0])
    ) {
        const kit = filter.root.children[0];
        if (kit.mode !== "include") {
            return undefined;
        }
        if (kit.presetId) {
            const byId = presets.find((preset) => preset.id === kit.presetId);
            if (byId) {
                return byId;
            }
        }
        const matches = presets.filter((preset) =>
            tagSetsEqual(preset.tags, kit.tags));
        return matches.length === 1 ? matches[0] : undefined;
    }
    const includes: string[] = [];
    for (const child of filter.root.children) {
        if (!isTagFilterClause(child)) {
            return undefined;
        }
        if (child.mode === "exclude") {
            return undefined;
        }
        includes.push(child.tag);
    }
    if (!includes.length) {
        return undefined;
    }
    const matches = presets.filter((preset) =>
        tagSetsEqual(preset.tags, includes));
    return matches.length === 1 ? matches[0] : undefined;
};

/**
 * Build a nearness seed filter that is exactly one kit unit.
 */
export const nearnessFilterFromKitTags = (
    tags: readonly string[],
    preset?: Pick<TagPreset, "id" | "name">,
): TagFilterSelection =>
    setKitModeOnFilter(
        emptyTagFilter(),
        {
            presetId: preset?.id ?? "",
            name: preset?.name ?? formatKitSuggestionName([...tags]),
            tags: [...tags],
        },
        "include",
    );

export type StampTagsFromNearness = {
    tags: string[];
    /** Prefer kit mode when the filter matches a preset. */
    pickMode: "kit" | "tag";
};

/**
 * Tags (and stamp pick mode) to apply when entering stamp with nearness on.
 * Matched kits use the full preset tag list; otherwise flat include clauses.
 */
export const stampTagsFromNearnessFilter = (
    filter: TagFilterSelection,
    presets: readonly TagPreset[],
): StampTagsFromNearness | undefined => {
    if (!isTagFilterActive(filter)) {
        return undefined;
    }
    const matched = matchNearnessFilterToKitPreset(filter, presets);
    if (matched) {
        return { tags: [...matched.tags], pickMode: "kit" };
    }
    if (!isFlatTagFilterRoot(filter.root)) {
        return undefined;
    }
    const includes: string[] = [];
    for (const child of filter.root.children) {
        if (isTagFilterClause(child) && child.mode === "include") {
            includes.push(child.tag);
        } else if (isTagFilterKit(child) && child.mode === "include") {
            includes.push(...child.tags);
        }
    }
    if (!includes.length) {
        return undefined;
    }
    return { tags: includes, pickMode: "tag" };
};

/**
 * How many files whose user tags are exactly the kit tag set (ONLY semantics).
 * Archived files are ignored (long-term storage).
 */
export const countFilesMatchingKitExact = (
    files: EnteFile[],
    kitTags: string[],
): number => {
    if (!kitTags.length || !files.length) {
        return 0;
    }
    const required = [...new Set(kitTags)];
    let matched = 0;
    for (const file of files) {
        if (isFileArchivedLocally(file)) {
            continue;
        }
        if (tagSetsEqual(extractUserTags(file), required)) {
            matched += 1;
        }
    }
    return matched;
};

export interface SortPresetsByMatchCountOptions {
    /** When true, rank by exact tag-set matches (ONLY); default is superset. */
    exact?: boolean;
}

/**
 * Sort kits by how many of `files` match, then by name. Returns counts so
 * callers do not recount.
 */
export const rankPresetsByMatchCount = (
    presets: TagPreset[],
    files: EnteFile[],
    options?: SortPresetsByMatchCountOptions,
): { preset: TagPreset; count: number }[] => {
    const score = options?.exact ?
        countFilesMatchingKitExact :
        countFilesMatchingKit;
    return [...presets]
        .map((preset) => ({ preset, count: score(files, preset.tags) }))
        .sort((a, b) => {
            if (b.count !== a.count) {
                return b.count - a.count;
            }
            return a.preset.name.localeCompare(b.preset.name);
        });
};

/**
 * Sort kits by how many of `files` match, then by name.
 */
export const sortPresetsByMatchCount = (
    presets: TagPreset[],
    files: EnteFile[],
    options?: SortPresetsByMatchCountOptions,
): TagPreset[] =>
    rankPresetsByMatchCount(presets, files, options).map((row) => row.preset);

/**
 * Canonical key for a tag set (order-independent).
 */
export const tagSetKey = (tags: string[]): string =>
    [...tags].sort((a, b) => a.localeCompare(b)).join("\0");

/**
 * Display name for a suggested kit: `"beach + vietnam"`.
 */
export const formatKitSuggestionName = (tags: string[]): string =>
    [...tags].sort((a, b) => a.localeCompare(b)).join(" + ");

export interface TagKitSuggestion {
    tags: string[];
    name: string;
    /** How many library files carry this exact tag set. */
    count: number;
}

export interface SuggestTagKitsOptions {
    /** Minimum files sharing the exact set (default 2). */
    minCount?: number;
    /** Max suggestions to return (default 40). */
    limit?: number;
    /** Existing presets to skip (same tag set). */
    existingPresets?: TagPreset[];
    /**
     * When set, only suggest kits whose every tag is opted into kit nearness.
     */
    includeInKitNearnessByName?: ReadonlyMap<string, boolean>;
}

/**
 * Rank recurring exact multi-tag sets from the library for kit suggestions.
 *
 * Each file with 2+ user tags contributes only its full tag set (not subsets
 * or pairs). Reserved/system tags are ignored via {@link extractUserTags}.
 * Archived files are skipped. When
 * {@link SuggestTagKitsOptions.includeInKitNearnessByName} is set, tag sets
 * that include any non–kit-nearness tag are skipped.
 */
export const suggestTagKits = (
    files: EnteFile[],
    options: SuggestTagKitsOptions = {},
): TagKitSuggestion[] => {
    const minCount = options.minCount ?? 2;
    const limit = options.limit ?? 40;
    const nearnessAllowlist = options.includeInKitNearnessByName;
    const excluded = new Set(
        (options.existingPresets ?? []).map((preset) => tagSetKey(preset.tags)),
    );

    const counts = new Map<string, { tags: string[]; count: number }>();
    for (const file of files) {
        if (isFileArchivedLocally(file)) {
            continue;
        }
        const tags = normalizePresetTags(extractUserTags(file));
        if (tags.length < 2) {
            continue;
        }
        if (
            nearnessAllowlist &&
            !areAllTagsIncludedInKitNearness(tags, nearnessAllowlist)
        ) {
            continue;
        }
        const key = tagSetKey(tags);
        if (excluded.has(key)) {
            continue;
        }
        const existing = counts.get(key);
        if (existing) {
            existing.count += 1;
            continue;
        }
        counts.set(key, {
            tags: [...tags].sort((a, b) => a.localeCompare(b)),
            count: 1,
        });
    }

    return [...counts.values()]
        .filter((entry) => entry.count >= minCount)
        .sort(
            (a, b) =>
                b.count - a.count ||
                a.tags.length - b.tags.length ||
                a.tags.join("\0").localeCompare(b.tags.join("\0")),
        )
        .slice(0, limit)
        .map((entry) => ({
            tags: entry.tags,
            name: formatKitSuggestionName(entry.tags),
            count: entry.count,
        }));
};

/**
 * Parse persisted presets; drop invalid entries.
 */
export const presetsFromPersisted = (
    raw: PersistedTagPresets | undefined,
): TagPreset[] => {
    if (!raw?.length) {
        return [];
    }
    const result: TagPreset[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        const name = normalizePresetName(String(entry.name ?? ""));
        const tags = normalizePresetTags(
            Array.isArray(entry.tags) ? entry.tags.map(String) : [],
        );
        if (!id || !name || tags.length === 0) {
            continue;
        }
        const nearnessTune = parseKitNearnessTuneResult(
            (entry as { nearnessTune?: unknown }).nearnessTune,
        );
        const preset: TagPreset = { id, name, tags };
        if (nearnessTune) {
            preset.nearnessTune = nearnessTune;
        }
        result.push(preset);
    }
    return result;
};

export const presetsToPersisted = (presets: TagPreset[]): PersistedTagPresets =>
    presets.map((preset) => {
        const row: TagPreset = {
            id: preset.id,
            name: preset.name,
            tags: [...preset.tags],
        };
        if (preset.nearnessTune) {
            row.nearnessTune = preset.nearnessTune;
        }
        return row;
    });
