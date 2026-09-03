import { extractTags, extractUserTags } from "@/lib/tags";
import type { EnteFile } from "ente-media/file";

/** Per-file snapshot used to undo a bulk tag mutation. */
export interface TagBulkUndoEntry {
    fileId: number;
    previousTags: string[];
}

export interface TagPresence {
    /** How many selected files currently have this tag. */
    count: number;
    total: number;
}

/**
 * Count how many files in a set carry each user tag (union + presence).
 */
export const tagPresenceAcrossFiles = (
    files: EnteFile[],
): { unionTags: string[]; presence: Map<string, TagPresence> } => {
    const total = files.length;
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const file of files) {
        for (const tag of extractUserTags(file)) {
            const prev = counts.get(tag) ?? 0;
            if (prev === 0) {
                order.push(tag);
            }
            counts.set(tag, prev + 1);
        }
    }
    const presence = new Map<string, TagPresence>();
    for (const tag of order) {
        presence.set(tag, { count: counts.get(tag) ?? 0, total });
    }
    return { unionTags: order, presence };
};

/**
 * Snapshot current tags for the given file ids (for undo).
 */
export const snapshotTagsForUndo = (
    files: EnteFile[],
    fileIds: number[],
): TagBulkUndoEntry[] => {
    const idSet = new Set(fileIds);
    const entries: TagBulkUndoEntry[] = [];
    for (const file of files) {
        if (!idSet.has(file.id)) {
            continue;
        }
        entries.push({
            fileId: file.id,
            previousTags: extractTags(file),
        });
    }
    return entries;
};

/**
 * Normalize pinned / recent tag lists: unique, trimmed, capped.
 */
export const normalizeTagNameList = (
    names: string[],
    max: number,
): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const name of names) {
        const trimmed = name.trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        result.push(trimmed);
        if (result.length >= max) {
            break;
        }
    }
    return result;
};

/**
 * Move `tag` to the front of a recent list (MRU).
 */
export const pushRecentTag = (
    recent: string[],
    tag: string,
    max: number,
): string[] => {
    const trimmed = tag.trim();
    if (!trimmed) {
        return recent;
    }
    return normalizeTagNameList(
        [trimmed, ...recent.filter((entry) => entry !== trimmed)],
        max,
    );
};

export const pushRecentTags = (
    recent: string[],
    tags: string[],
    max: number,
): string[] => {
    let next = recent;
    for (let i = tags.length - 1; i >= 0; i -= 1) {
        const tag = tags[i];
        if (tag) {
            next = pushRecentTag(next, tag, max);
        }
    }
    return next;
};
