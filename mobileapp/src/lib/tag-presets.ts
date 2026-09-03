import { normalizeTagName } from "@/lib/tag-writes";
import { extractUserTags } from "@/lib/tags";
import type { EnteFile } from "ente-media/file";

export interface TagPreset {
    id: string;
    name: string;
    tags: string[];
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
 * How many files already have every tag in the kit.
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
        const have = new Set(extractUserTags(file));
        if (kitTags.every((tag) => have.has(tag))) {
            matched += 1;
        }
    }
    return matched;
};

/**
 * Sort kits by how many of `files` fully match, then by name.
 */
export const sortPresetsByMatchCount = (
    presets: TagPreset[],
    files: EnteFile[],
): TagPreset[] =>
    [...presets].sort((a, b) => {
        const scoreA = countFilesMatchingKit(files, a.tags);
        const scoreB = countFilesMatchingKit(files, b.tags);
        if (scoreB !== scoreA) {
            return scoreB - scoreA;
        }
        return a.name.localeCompare(b.name);
    });

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
}

/**
 * Rank recurring exact multi-tag sets from the library for kit suggestions.
 *
 * Each file with 2+ user tags contributes only its full tag set (not subsets
 * or pairs). Reserved/system tags are ignored via {@link extractUserTags}.
 */
export const suggestTagKits = (
    files: EnteFile[],
    options: SuggestTagKitsOptions = {},
): TagKitSuggestion[] => {
    const minCount = options.minCount ?? 2;
    const limit = options.limit ?? 40;
    const excluded = new Set(
        (options.existingPresets ?? []).map((preset) => tagSetKey(preset.tags)),
    );

    const counts = new Map<string, { tags: string[]; count: number }>();
    for (const file of files) {
        const tags = normalizePresetTags(extractUserTags(file));
        if (tags.length < 2) {
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
        result.push({ id, name, tags });
    }
    return result;
};

export const presetsToPersisted = (presets: TagPreset[]): PersistedTagPresets =>
    presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        tags: [...preset.tags],
    }));
