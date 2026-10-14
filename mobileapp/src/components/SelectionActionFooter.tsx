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
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { ToolFooter } from "@/components/ToolFooter";
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
import { workingSetTags } from "@/lib/tag-presets";
import { extractUserTags } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { useLibraryStore } from "@/stores/library-store";
import { selectedIdSet, useSelectionStore } from "@/stores/selection-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";
import { toast } from "sonner";
import { errorMessage, plural } from "@/lib/format";

type BusyAction = "tag" | "favorite" | "archive" | "trash";

const isFullyApplied = (
    info: { count: number; total: number } | undefined,
): boolean =>
    info !== undefined && info.total > 0 && info.count === info.total;

export function SelectionActionFooter(): JSX.Element | null {
    const enabled = useSelectionStore((s) => s.mode === "select");
    const selectedIds = useSelectionStore((s) => s.selectedIds);
    const setMode = useSelectionStore((s) => s.setMode);

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
    const [busy, setBusy] = useState<BusyAction | undefined>();
    /** Sheet-only: staged-edit write failures, shown inside the tag sheet. */
    const [tagError, setTagError] = useState<string | undefined>();
    const [trashOpen, setTrashOpen] = useState<boolean>(false);
    const tagFlushLockRef = useRef<boolean>(false);

    const selectedFiles = useMemo(
        () => {
            const idSet = selectedIdSet(selectedIds);
            return allFiles.filter((file) => idSet.has(file.id));
        },
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

    const chipTags = useMemo(
        () => workingSetTags(pinnedTags, recentTags),
        [pinnedTags, recentTags],
    );

    const exitSelection = useCallback((): void => {
        setMode("none");
    }, [setMode]);

    const stageDraft = useCallback(
        (mutator: (current: TagDraft) => TagDraft): void => {
            setTagDraft((current) =>
                pruneTagDraft(mutator(current), livePresence.presence));
            setTagError(undefined);
        },
        [livePresence.presence],
    );

    /** Runs one footer action under the shared busy state; toasts on failure. */
    const runAction = useCallback(
        async (
            kind: BusyAction,
            task: () => Promise<unknown>,
            failText: string,
        ): Promise<boolean> => {
            setBusy(kind);
            try {
                await task();
                return true;
            } catch (error) {
                toast.error(errorMessage(error, failText));
                return false;
            } finally {
                setBusy(undefined);
            }
        },
        [],
    );

    /** Runs a footer tag write and leaves selection mode once it succeeds. */
    const runTagAction = useCallback(
        async (task: () => Promise<unknown>): Promise<void> => {
            if (await runAction("tag", task, "Could not update tags")) {
                exitSelection();
            }
        },
        [exitSelection, runAction],
    );

    /** Flush staged sheet edits. `"applied"` means tags were written. */
    const flushTagDraft = useCallback(async (): Promise<
        "empty" | "applied" | "failed"
    > => {
        if (tagFlushLockRef.current) {
            return "failed";
        }
        if (!tagDraftHasChanges(tagDraft) || !selectedIds.length) {
            setTagDraft(emptyTagDraft());
            return "empty";
        }
        tagFlushLockRef.current = true;
        setBusy("tag");
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
            return "applied";
        } catch (error) {
            setTagError(
                errorMessage(error, "Could not update tags"),
            );
            return "failed";
        } finally {
            tagFlushLockRef.current = false;
            setBusy(undefined);
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
            if (busy === "tag" || tagFlushLockRef.current) {
                return;
            }
            void (async () => {
                const result = await flushTagDraft();
                if (result === "failed") {
                    return;
                }
                setTagsOpen(false);
                setTagError(undefined);
                if (result === "applied") {
                    exitSelection();
                }
            })();
        },
        [busy, exitSelection, flushTagDraft, openTagSheet],
    );

    const handleApplyTagDraft = useCallback((): void => {
        if (busy === "tag" || tagFlushLockRef.current) {
            return;
        }
        void (async () => {
            const result = await flushTagDraft();
            if (result === "applied") {
                setTagsOpen(false);
                exitSelection();
            }
        })();
    }, [busy, exitSelection, flushTagDraft]);

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

    const handleWorkingSetTap = useCallback(
        async (tag: string): Promise<void> => {
            if (!selectedIds.length) {
                return;
            }
            const fullyOn = isFullyApplied(presence.get(tag));
            await runTagAction(() =>
                fullyOn ?
                    bulkRemoveTags(selectedIds, [tag]) :
                    bulkAddTags(selectedIds, [tag]));
        },
        [presence, runTagAction, selectedIds],
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
        await runTagAction(() => bulkAddTags(targets, tags));
    }, [runTagAction, selectedFiles]);

    const handleFavorite = useCallback(
        async (isFavorite: boolean): Promise<void> => {
            if (!selectedIds.length || busy) {
                return;
            }
            const ok = await runAction(
                "favorite",
                () => batchSetFavorite(selectedIds, isFavorite),
                "Could not update favourites",
            );
            if (ok) {
                exitSelection();
            }
        },
        [batchSetFavorite, busy, exitSelection, runAction, selectedIds],
    );

    const handleArchive = useCallback(async (): Promise<void> => {
        if (!selectedIds.length || busy) {
            return;
        }
        const ids = [...selectedIds];
        const ok = await runAction(
            "archive",
            () => batchSetArchived(ids, true),
            "Could not archive",
        );
        if (ok) {
            exitSelection();
            toast.success(`Archived ${plural(ids.length, "photo")}`);
        }
    }, [batchSetArchived, busy, exitSelection, runAction, selectedIds]);

    const handleTrash = useCallback(async (): Promise<void> => {
        if (!selectedIds.length) {
            return;
        }
        const ok = await runAction(
            "trash",
            () => moveFilesToTrash(selectedIds),
            "Could not move to trash",
        );
        if (ok) {
            setTrashOpen(false);
            exitSelection();
        }
    }, [exitSelection, moveFilesToTrash, runAction, selectedIds]);

    if (!enabled) {
        return null;
    }

    const count = selectedIds.length;
    const actionsBusy = busy !== undefined;
    const draftPending = tagDraftHasChanges(tagDraft);
    /** Avoid footer chips fighting a staged sheet draft. */
    const footerTagActionsDisabled = actionsBusy || tagsOpen;

    if (count === 0) {
        return (
            <ToolFooter
                title="Select · tap photos"
                actions={
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={exitSelection}
                    >
                        Done
                    </Button>
                }
            />
        );
    }

    return (
        <>
            <ToolFooter
                title={`${count} selected`}
                actions={
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={actionsBusy}
                        onClick={exitSelection}
                    >
                        Done
                    </Button>
                }
            >
                {chipTags.length > 0 || presets.length > 0 ? (
                    <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                        {chipTags.map((tag) => {
                            const info = presence.get(tag);
                            const fullyOn = isFullyApplied(info);
                            const partial =
                                info !== undefined &&
                                info.count > 0 &&
                                info.count < info.total;
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
                                    void runTagAction(() =>
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
                        {busy === "tag" ? (
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
                        {busy === "favorite" ? (
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
                        {busy === "favorite" ? (
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
                        {busy === "archive" ? (
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
            </ToolFooter>

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
                applyBusy={busy === "tag"}
                batchSelectionHint="Tap tags or kits to stage changes. Apply once, or close the sheet to save."
                onOpenChange={handleTagSheetOpenChange}
                onAddTag={handleDraftAddTag}
                onRemoveTag={handleDraftRemoveTag}
                onApplyPreset={handleDraftApplyPreset}
                onApply={handleApplyTagDraft}
                onTogglePinTag={togglePinnedTag}
            />

            <ConfirmDialog
                open={trashOpen}
                title={`Move ${plural(count, "item")} to trash?`}
                description="They can be restored from the Ente app."
                confirmLabel="Move to trash"
                destructive
                isWorking={busy === "trash"}
                onCancel={() => setTrashOpen(false)}
                onConfirm={() => {
                    void handleTrash();
                }}
            />
        </>
    );
}
