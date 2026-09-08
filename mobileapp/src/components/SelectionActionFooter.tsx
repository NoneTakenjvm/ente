import {
    useCallback,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import {
    Archive,
    Copy,
    Heart,
    HeartOff,
    Tag,
    Trash2,
} from "lucide-react";
import { ConfirmBatchTrashModal } from "@/components/ConfirmBatchTrashModal";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
    bulkAddTags,
    bulkApplyTagDraft,
    bulkRemoveTags,
} from "@/lib/tag-bulk-actions";
import {
    draftAddTag,
    draftAddTags,
    draftRemoveTag,
    emptyTagDraft,
    overlayTagDraftPresence,
    pruneTagDraft,
    tagDraftHasChanges,
    tagPresenceAcrossFiles,
    type TagDraft,
} from "@/lib/tag-bulk";
import { extractUserTags } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { useLibraryStore } from "@/stores/library-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";
import { toast } from "sonner";

export function SelectionActionFooter(): JSX.Element | null {
    const enabled = useSelectionStore((s) => s.enabled);
    const selectedIds = useSelectionStore((s) => s.selectedIds);
    const setEnabled = useSelectionStore((s) => s.setEnabled);

    const allFiles = useLibraryStore((s) => s.allFiles);
    const batchSetFavorite = useLibraryStore((s) => s.batchSetFavorite);
    const batchSetArchived = useLibraryStore((s) => s.batchSetArchived);
    const moveFilesToTrash = useLibraryStore((s) => s.moveFilesToTrash);
    const knownTags = useTagStore((s) => s.tags);

    const presets = useTagSpeedStore((s) => s.presets);
    const pinnedTags = useTagSpeedStore((s) => s.pinnedTags);
    const recentTags = useTagSpeedStore((s) => s.recentTags);
    const togglePinnedTag = useTagSpeedStore((s) => s.togglePinnedTag);

    const [tagsOpen, setTagsOpen] = useState<boolean>(false);
    const [tagDraft, setTagDraft] = useState<TagDraft>(emptyTagDraft);
    const [tagBusy, setTagBusy] = useState<boolean>(false);
    const [tagError, setTagError] = useState<string | undefined>();
    const [favoriteBusy, setFavoriteBusy] = useState<boolean>(false);
    const [archiveBusy, setArchiveBusy] = useState<boolean>(false);
    const [trashOpen, setTrashOpen] = useState<boolean>(false);
    const [trashBusy, setTrashBusy] = useState<boolean>(false);
    const tagFlushLockRef = useRef<boolean>(false);

    const selectedFiles = useMemo(
        () => allFiles.filter((file) => selectedIds.includes(file.id)),
        [allFiles, selectedIds],
    );

    const livePresence = useMemo(
        () => tagPresenceAcrossFiles(selectedFiles),
        [selectedFiles],
    );

    /** Footer chips still reflect live library state (immediate writes). */
    const { presence } = livePresence;

    const draftView = useMemo(
        () =>
            overlayTagDraftPresence(
                livePresence,
                tagDraft,
                selectedFiles.length,
            ),
        [livePresence, selectedFiles.length, tagDraft],
    );

    const sheetKnownTags = useMemo((): string[] => {
        const seen = new Set(knownTags);
        const extra: string[] = [];
        for (const tag of [...draftView.unionTags, ...tagDraft.adds]) {
            if (seen.has(tag)) {
                continue;
            }
            seen.add(tag);
            extra.push(tag);
        }
        return extra.length ? [...knownTags, ...extra] : knownTags;
    }, [draftView.unionTags, knownTags, tagDraft.adds]);

    const workingSetTags = useMemo((): string[] => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const tag of [...pinnedTags, ...recentTags]) {
            if (seen.has(tag)) {
                continue;
            }
            seen.add(tag);
            result.push(tag);
        }
        return result.slice(0, 16);
    }, [pinnedTags, recentTags]);

    const exitSelection = useCallback((): void => {
        setEnabled(false);
    }, [setEnabled]);

    const stageDraft = useCallback(
        (mutator: (current: TagDraft) => TagDraft): void => {
            setTagDraft((current) =>
                pruneTagDraft(mutator(current), livePresence.presence));
            setTagError(undefined);
        },
        [livePresence.presence],
    );

    const runTagBusy = useCallback(
        async (task: () => Promise<{ failed: number }>): Promise<void> => {
            setTagBusy(true);
            setTagError(undefined);
            try {
                await task();
            } catch (error) {
                setTagError(
                    error instanceof Error ?
                        error.message :
                        "Could not update tags",
                );
            } finally {
                setTagBusy(false);
            }
        },
        [],
    );

    const flushTagDraft = useCallback(async (): Promise<boolean> => {
        if (tagFlushLockRef.current) {
            return false;
        }
        if (!tagDraftHasChanges(tagDraft) || !selectedIds.length) {
            setTagDraft(emptyTagDraft());
            return true;
        }
        tagFlushLockRef.current = true;
        setTagBusy(true);
        setTagError(undefined);
        try {
            const result = await bulkApplyTagDraft(selectedIds, tagDraft);
            setTagDraft(emptyTagDraft());
            if (result.failed > 0) {
                setTagError(
                    `Updated ${result.succeeded}, ${result.failed} failed`,
                );
            }
            // Optimistic local write already applied; clear draft either way.
            return true;
        } catch (error) {
            setTagError(
                error instanceof Error ?
                    error.message :
                    "Could not update tags",
            );
            return false;
        } finally {
            tagFlushLockRef.current = false;
            setTagBusy(false);
        }
    }, [selectedIds, tagDraft]);

    const openTagSheet = useCallback((): void => {
        setTagError(undefined);
        setTagDraft(emptyTagDraft());
        setTagsOpen(true);
    }, []);

    const handleTagSheetOpenChange = useCallback(
        (open: boolean): void => {
            if (open) {
                openTagSheet();
                return;
            }
            if (tagBusy || tagFlushLockRef.current) {
                return;
            }
            void (async () => {
                const ok = await flushTagDraft();
                if (ok) {
                    setTagsOpen(false);
                    setTagError(undefined);
                }
            })();
        },
        [flushTagDraft, openTagSheet, tagBusy],
    );

    const handleApplyTagDraft = useCallback((): void => {
        if (tagBusy || tagFlushLockRef.current) {
            return;
        }
        void flushTagDraft();
    }, [flushTagDraft, tagBusy]);

    const handleDraftAddTag = useCallback(
        (tagName: string): void => {
            stageDraft((current) => draftAddTag(current, tagName));
        },
        [stageDraft],
    );

    const handleDraftRemoveTag = useCallback(
        (tagName: string): void => {
            stageDraft((current) => draftRemoveTag(current, tagName));
        },
        [stageDraft],
    );

    const handleDraftApplyPreset = useCallback(
        (tags: string[]): void => {
            if (!tags.length) {
                return;
            }
            stageDraft((current) => draftAddTags(current, tags));
        },
        [stageDraft],
    );

    const handleBatchAddTag = useCallback(
        async (tagName: string): Promise<void> => {
            if (!selectedIds.length) {
                return;
            }
            await runTagBusy(() => bulkAddTags(selectedIds, [tagName]));
        },
        [runTagBusy, selectedIds],
    );

    const handleBatchRemoveTag = useCallback(
        async (tagName: string): Promise<void> => {
            if (!selectedIds.length) {
                return;
            }
            await runTagBusy(() => bulkRemoveTags(selectedIds, [tagName]));
        },
        [runTagBusy, selectedIds],
    );

    const handleWorkingSetTap = useCallback(
        async (tag: string): Promise<void> => {
            if (!selectedIds.length) {
                return;
            }
            const info = presence.get(tag);
            if (info && info.count === info.total && info.total > 0) {
                await handleBatchRemoveTag(tag);
            } else {
                await handleBatchAddTag(tag);
            }
        },
        [
            handleBatchAddTag,
            handleBatchRemoveTag,
            presence,
            selectedIds.length,
        ],
    );

    const handleCopyTagsFromFirst = useCallback(async (): Promise<void> => {
        if (selectedFiles.length < 2) {
            toast.message("Select at least two photos");
            return;
        }
        const source = selectedFiles[0];
        if (!source) {
            return;
        }
        const tags = extractUserTags(source);
        if (!tags.length) {
            toast.message("First selected photo has no tags");
            return;
        }
        const targets = selectedFiles.slice(1).map((file) => file.id);
        await runTagBusy(() => bulkAddTags(targets, tags));
    }, [runTagBusy, selectedFiles]);

    const handleFavorite = useCallback(
        async (isFavorite: boolean): Promise<void> => {
            if (!selectedIds.length || favoriteBusy) {
                return;
            }
            setFavoriteBusy(true);
            try {
                await batchSetFavorite(selectedIds, isFavorite);
                exitSelection();
            } catch (error) {
                toast.error(
                    error instanceof Error ?
                        error.message :
                        "Could not update favourites",
                );
            } finally {
                setFavoriteBusy(false);
            }
        },
        [batchSetFavorite, exitSelection, favoriteBusy, selectedIds],
    );

    const handleArchive = useCallback(async (): Promise<void> => {
        if (!selectedIds.length || archiveBusy) {
            return;
        }
        const ids = [...selectedIds];
        setArchiveBusy(true);
        try {
            await batchSetArchived(ids, true);
            exitSelection();
            toast.success(
                ids.length === 1 ?
                    "Archived 1 photo" :
                    `Archived ${ids.length} photos`,
            );
        } catch (error) {
            toast.error(
                error instanceof Error ?
                    error.message :
                    "Could not archive",
            );
        } finally {
            setArchiveBusy(false);
        }
    }, [archiveBusy, batchSetArchived, exitSelection, selectedIds]);

    const handleTrash = useCallback(async (): Promise<void> => {
        if (!selectedIds.length) {
            return;
        }
        setTrashBusy(true);
        try {
            await moveFilesToTrash(selectedIds);
            setTrashOpen(false);
            exitSelection();
        } catch (error) {
            toast.error(
                error instanceof Error ?
                    error.message :
                    "Could not move to trash",
            );
        } finally {
            setTrashBusy(false);
        }
    }, [exitSelection, moveFilesToTrash, selectedIds]);

    if (!enabled) {
        return null;
    }

    const count = selectedIds.length;
    const actionsBusy = tagBusy || favoriteBusy || archiveBusy || trashBusy;
    const draftPending = tagDraftHasChanges(tagDraft);
    /** Avoid footer chips fighting a staged sheet draft. */
    const footerTagActionsDisabled = actionsBusy || tagsOpen;

    if (count === 0) {
        return null;
    }

    return (
        <>
            <footer className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex flex-col gap-2 border-t border-border bg-background/95 px-3 py-2.5 backdrop-blur">
                <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-sm text-muted-foreground">
                        {count} selected
                    </p>
                </div>

                {workingSetTags.length > 0 || presets.length > 0 ? (
                    <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                        {workingSetTags.map((tag) => {
                            const info = presence.get(tag);
                            const fullyOn =
                                Boolean(info) &&
                                info!.count === info!.total &&
                                info!.total > 0;
                            const partial =
                                Boolean(info) &&
                                info!.count > 0 &&
                                info!.count < info!.total;
                            return (
                                <Button
                                    key={tag}
                                    type="button"
                                    variant={fullyOn ? "secondary" : "outline"}
                                    size="sm"
                                    className={cn(
                                        "h-8 shrink-0",
                                        partial && "border-dashed",
                                    )}
                                    disabled={footerTagActionsDisabled}
                                    onClick={() => {
                                        void handleWorkingSetTap(tag);
                                    }}
                                    onContextMenu={(event) => {
                                        event.preventDefault();
                                        togglePinnedTag(tag);
                                    }}
                                >
                                    {tag}
                                    {info && info.total > 1 ? (
                                        <span className="ml-1 tabular-nums text-muted-foreground">
                                            {info.count}/{info.total}
                                        </span>
                                    ) : null}
                                </Button>
                            );
                        })}
                        {presets.slice(0, 4).map((preset) => (
                            <Button
                                key={preset.id}
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 shrink-0 border-dashed"
                                disabled={footerTagActionsDisabled}
                                onClick={() => {
                                    void runTagBusy(() =>
                                        bulkAddTags(selectedIds, preset.tags));
                                }}
                            >
                                {preset.name}
                            </Button>
                        ))}
                    </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={actionsBusy}
                        onClick={openTagSheet}
                    >
                        {tagBusy ? (
                            <Spinner />
                        ) : (
                            <Tag className="size-3.5 shrink-0" />
                        )}
                        Tags
                    </Button>
                    {count >= 2 ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            disabled={footerTagActionsDisabled}
                            title="Copy tags from first selected onto the rest"
                            onClick={() => {
                                void handleCopyTagsFromFirst();
                            }}
                        >
                            <Copy className="size-3.5 shrink-0" />
                            Copy tags
                        </Button>
                    ) : null}
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={actionsBusy}
                        onClick={() => {
                            void handleFavorite(true);
                        }}
                    >
                        {favoriteBusy ? (
                            <Spinner />
                        ) : (
                            <Heart className="size-3.5 shrink-0" />
                        )}
                        Favourite
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={actionsBusy}
                        onClick={() => {
                            void handleFavorite(false);
                        }}
                    >
                        {favoriteBusy ? (
                            <Spinner />
                        ) : (
                            <HeartOff className="size-3.5 shrink-0" />
                        )}
                        Unfavourite
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={actionsBusy}
                        onClick={() => {
                            void handleArchive();
                        }}
                    >
                        {archiveBusy ? (
                            <Spinner />
                        ) : (
                            <Archive className="size-3.5 shrink-0" />
                        )}
                        Archive
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        className="text-destructive hover:text-destructive"
                        aria-label="Move to trash"
                        disabled={actionsBusy}
                        onClick={() => setTrashOpen(true)}
                    >
                        <Trash2 />
                    </Button>
                </div>
            </footer>

            <TagPickerSheet
                open={tagsOpen}
                appliedTags={draftView.appliedTags}
                knownTags={sheetKnownTags}
                error={tagError}
                tagPresence={draftView.presence}
                presets={presets}
                kitScoreFiles={selectedFiles}
                defaultToKits={presets.length > 0}
                pinnedTags={pinnedTags}
                pendingChanges={draftPending}
                applyBusy={tagBusy}
                batchSelectionHint="Tap tags or kits to stage changes. Apply once, or close the sheet to save."
                onOpenChange={handleTagSheetOpenChange}
                onAddTag={handleDraftAddTag}
                onRemoveTag={handleDraftRemoveTag}
                onApplyPreset={handleDraftApplyPreset}
                onApply={handleApplyTagDraft}
                onTogglePinTag={togglePinnedTag}
            />

            <ConfirmBatchTrashModal
                open={trashOpen}
                count={count}
                isWorking={trashBusy}
                onCancel={() => {
                    if (!trashBusy) {
                        setTrashOpen(false);
                    }
                }}
                onConfirm={() => {
                    void handleTrash();
                }}
            />
        </>
    );
}
