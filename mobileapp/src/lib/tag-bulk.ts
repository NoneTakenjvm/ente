import { extractTags, extractUserTags } from "@/lib/tags";
import { normalizeTagName } from "@/lib/tag-writes";
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
 * Pending bulk tag edits staged in the selection Tags sheet before one write.
 */
export interface TagDraft {
    adds: string[];
    removes: string[];
}

export const emptyTagDraft = (): TagDraft => ({ adds: [], removes: [] });

export const tagDraftHasChanges = (draft: TagDraft): boolean =>
    draft.adds.length > 0 || draft.removes.length > 0;

/**
 * Stage adding a tag to every selected file (clears a pending remove).
 */
export const draftAddTag = (draft: TagDraft, tag: string): TagDraft => {
    const name = normalizeTagName(tag);
    if (!name) {
        return draft;
    }
    return {
        adds: draft.adds.includes(name) ? draft.adds : [...draft.adds, name],
        removes: draft.removes.filter((entry) => entry !== name),
    };
};

/**
 * Stage removing a tag from every selected file (clears a pending add).
 */
export const draftRemoveTag = (draft: TagDraft, tag: string): TagDraft => {
    const name = normalizeTagName(tag);
    if (!name) {
        return draft;
    }
    return {
        adds: draft.adds.filter((entry) => entry !== name),
        removes: draft.removes.includes(name) ?
            draft.removes :
            [...draft.removes, name],
    };
};

/**
 * Stage adding every tag in a kit / preset.
 */
export const draftAddTags = (draft: TagDraft, tags: string[]): TagDraft => {
    let next = draft;
    for (const tag of tags) {
        next = draftAddTag(next, tag);
    }
    return next;
};

/**
 * Overlay a draft onto live selection presence for the Tags sheet UI.
 */
export const overlayTagDraftPresence = (
    baseline: { unionTags: string[]; presence: Map<string, TagPresence> },
    draft: TagDraft,
    total: number,
): { unionTags: string[]; presence: Map<string, TagPresence>; appliedTags: string[] } => {
    const presence = new Map(baseline.presence);
    const order = [...baseline.unionTags];

    for (const tag of draft.removes) {
        presence.set(tag, { count: 0, total });
    }
    for (const tag of draft.adds) {
        if (!order.includes(tag)) {
            order.push(tag);
        }
        presence.set(tag, { count: total, total });
    }

    const appliedTags = order.filter((tag) => {
        const info = presence.get(tag);
        return Boolean(info && info.count === info.total && info.total > 0);
    });

    return { unionTags: order, presence, appliedTags };
};

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
