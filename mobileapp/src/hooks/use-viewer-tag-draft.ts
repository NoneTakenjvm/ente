import { startTransition, useCallback, useRef, useState } from "react";
import { errorMessage } from "@/lib/format";
import { requestTagOutboxFlush } from "@/lib/outbox-runner";
import { isReservedTag } from "@/lib/tag-filter";
import { enqueueTagOutboxEntries } from "@/lib/tag-outbox";
import {
    addTagNames,
    applyTagMutator,
    normalizeTagName,
    removeTagNames,
    tagsEqual,
} from "@/lib/tag-writes";
import { extractTags, extractUserTags, isSystemTag } from "@/lib/tags";
import { useLibraryStore } from "@/stores/library-store";
import type { EnteFile } from "ente-media/file";

export interface ViewerTagDraft {
    showTagPicker: boolean;
    /** Draft tags while the sheet is open; `null` otherwise. */
    stagedTags: string[] | null;
    tagSaveBusy: boolean;
    tagError: string | undefined;
    beginTagDraft: () => void;
    flushTagDraft: () => void;
    addTag: (name: string) => void;
    removeTag: (tag: string) => void;
}

/**
 * Tag sheet draft for the viewer: edits are staged locally and committed
 * (outbox + store write) when the sheet closes.
 *
 * @param displayFile file the draft starts from.
 * @param syncSessionFile refreshes the viewer's copy of a file from the store.
 */
export function useViewerTagDraft(
    displayFile: EnteFile | undefined,
    syncSessionFile: (fileId: number) => void,
): ViewerTagDraft {
    const [tagError, setTagError] = useState<string | undefined>();
    const [tagSaveBusy, setTagSaveBusy] = useState<boolean>(false);
    const [showTagPicker, setShowTagPicker] = useState<boolean>(false);
    const [stagedTags, setStagedTags] = useState<string[] | null>(null);
    const updateTagsOnFile = useLibraryStore((s) => s.updateTagsOnFile);

    const tagBaselineRef = useRef<string[]>([]);
    /** File the open draft belongs to; flush writes to it, not the current slide. */
    const tagDraftFileRef = useRef<EnteFile | undefined>(undefined);
    /** Mirrors {@link stagedTags} so close flush always reads the latest draft. */
    const stagedTagsRef = useRef<string[] | null>(null);

    const beginTagDraft = useCallback((): void => {
        const baseline = displayFile ? extractUserTags(displayFile) : [];
        tagDraftFileRef.current = displayFile;
        tagBaselineRef.current = [...baseline];
        stagedTagsRef.current = [...baseline];
        setStagedTags([...baseline]);
        setTagError(undefined);
        setShowTagPicker(true);
    }, [displayFile]);

    const flushTagDraft = useCallback((): void => {
        const draftFile = tagDraftFileRef.current;
        tagDraftFileRef.current = undefined;
        if (!draftFile) {
            stagedTagsRef.current = null;
            setStagedTags(null);
            setShowTagPicker(false);
            return;
        }
        const fileId = draftFile.id;
        const latestFile =
            useLibraryStore.getState().getFileById(fileId) ?? draftFile;
        const intendedTags =
            stagedTagsRef.current ?? extractUserTags(latestFile);
        setShowTagPicker(false);
        if (tagsEqual(tagBaselineRef.current, intendedTags)) {
            stagedTagsRef.current = null;
            setStagedTags(null);
            return;
        }

        setTagSaveBusy(true);
        setTagError(undefined);
        stagedTagsRef.current = null;
        setStagedTags(null);
        tagBaselineRef.current = intendedTags;

        const mutator = (current: string[]): string[] => [
            ...current.filter((tag) => isSystemTag(tag)),
            ...intendedTags,
        ];
        // Enqueue before yielding so a kill during rAF cannot void the draft.
        enqueueTagOutboxEntries([
            {
                fileId,
                intendedTags: applyTagMutator(mutator, extractTags(latestFile)),
            },
        ]);
        requestTagOutboxFlush();

        // Let the sheet close paint before store + gallery work runs.
        requestAnimationFrame(() => {
            startTransition(() => {
                void updateTagsOnFile(fileId, mutator)
                    .then(() => {
                        syncSessionFile(fileId);
                    })
                    .catch((error: unknown) => {
                        syncSessionFile(fileId);
                        setTagError(errorMessage(error, "Could not save tags"));
                    })
                    .finally(() => {
                        setTagSaveBusy(false);
                    });
            });
        });
    }, [syncSessionFile, updateTagsOnFile]);

    const addTag = useCallback((name: string): void => {
        const normalized = normalizeTagName(name);
        if (!normalized || isReservedTag(normalized)) {
            return;
        }
        setTagError(undefined);
        setStagedTags((current) => {
            if (!current) {
                return current;
            }
            const next = addTagNames(current, normalized);
            stagedTagsRef.current = next;
            return next;
        });
    }, []);

    const removeTag = useCallback((tag: string): void => {
        setTagError(undefined);
        setStagedTags((current) => {
            if (!current) {
                return current;
            }
            const next = removeTagNames(current, tag);
            stagedTagsRef.current = next;
            return next;
        });
    }, []);

    return {
        showTagPicker,
        stagedTags,
        tagSaveBusy,
        tagError,
        beginTagDraft,
        flushTagDraft,
        addTag,
        removeTag,
    };
}
