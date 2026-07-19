import {
    useCallback,
    useMemo,
    useState,
    type JSX,
} from "react";
import {
    Archive,
    Heart,
    HeartOff,
    Tag,
    Trash2,
} from "lucide-react";
import { ConfirmBatchTrashModal } from "@/components/ConfirmBatchTrashModal";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { extractUserTags } from "@/lib/tags";
import { addTagNames, removeTagNames } from "@/lib/tag-writes";
import { useLibraryStore } from "@/stores/library-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagStore } from "@/stores/tag-store";
import { toast } from "sonner";

export function SelectionActionFooter(): JSX.Element | null {
    const enabled = useSelectionStore((s) => s.enabled);
    const selectedIds = useSelectionStore((s) => s.selectedIds);
    const setEnabled = useSelectionStore((s) => s.setEnabled);

    const allFiles = useLibraryStore((s) => s.allFiles);
    const batchUpdateTagsOnFiles = useLibraryStore((s) => s.batchUpdateTagsOnFiles);
    const batchSetFavorite = useLibraryStore((s) => s.batchSetFavorite);
    const batchSetArchived = useLibraryStore((s) => s.batchSetArchived);
    const moveFilesToTrash = useLibraryStore((s) => s.moveFilesToTrash);
    const knownTags = useTagStore((s) => s.tags);

    const [tagsOpen, setTagsOpen] = useState<boolean>(false);
    const [tagBusy, setTagBusy] = useState<boolean>(false);
    const [tagError, setTagError] = useState<string | undefined>();
    const [favoriteBusy, setFavoriteBusy] = useState<boolean>(false);
    const [archiveBusy, setArchiveBusy] = useState<boolean>(false);
    const [trashOpen, setTrashOpen] = useState<boolean>(false);
    const [trashBusy, setTrashBusy] = useState<boolean>(false);

    const selectedFiles = useMemo(
        () => allFiles.filter((file) => selectedIds.includes(file.id)),
        [allFiles, selectedIds],
    );

    const unionTags = useMemo((): string[] => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const file of selectedFiles) {
            for (const tag of extractUserTags(file)) {
                if (!seen.has(tag)) {
                    seen.add(tag);
                    result.push(tag);
                }
            }
        }
        return result;
    }, [selectedFiles]);

    const exitSelection = useCallback((): void => {
        setEnabled(false);
    }, [setEnabled]);

    const handleBatchAddTag = useCallback(
        async (tagName: string): Promise<void> => {
            if (!selectedIds.length) {
                return;
            }
            setTagBusy(true);
            setTagError(undefined);
            try {
                const result = await batchUpdateTagsOnFiles(
                    selectedIds,
                    (tags) => addTagNames(tags, tagName),
                );
                if (result.failed > 0) {
                    toast.error(
                        `Tagged ${result.succeeded}, ${result.failed} failed`,
                    );
                } else {
                    setTagsOpen(false);
                    exitSelection();
                }
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
        [batchUpdateTagsOnFiles, exitSelection, selectedIds],
    );

    const handleBatchRemoveTag = useCallback(
        async (tagName: string): Promise<void> => {
            if (!selectedIds.length) {
                return;
            }
            setTagBusy(true);
            setTagError(undefined);
            try {
                const result = await batchUpdateTagsOnFiles(
                    selectedIds,
                    (tags) => removeTagNames(tags, tagName),
                );
                if (result.failed > 0) {
                    toast.error(
                        `Updated ${result.succeeded}, ${result.failed} failed`,
                    );
                } else {
                    setTagsOpen(false);
                    exitSelection();
                }
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
        [batchUpdateTagsOnFiles, exitSelection, selectedIds],
    );

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

    if (!enabled || selectedIds.length === 0) {
        return null;
    }

    const count = selectedIds.length;
    const actionsBusy = tagBusy || favoriteBusy || archiveBusy || trashBusy;

    return (
        <>
            <footer className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex flex-col gap-2 border-t border-border bg-background/95 px-3 py-3 backdrop-blur">
                <p className="shrink-0 text-sm text-muted-foreground">
                    {count} selected
                </p>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={actionsBusy}
                        onClick={() => {
                            setTagError(undefined);
                            setTagsOpen(true);
                        }}
                    >
                        <Tag className="size-3.5 shrink-0" />
                        Tags
                    </Button>
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
                appliedTags={unionTags}
                knownTags={knownTags}
                error={tagError}
                batchSelectionHint="Highlighted tags appear on at least one selected item. Tap to add to all selected, or remove from all selected."
                onOpenChange={(open) => {
                    if (!open && !tagBusy) {
                        setTagsOpen(false);
                        setTagError(undefined);
                    }
                }}
                onAddTag={(name) => {
                    void handleBatchAddTag(name);
                }}
                onRemoveTag={(name) => {
                    void handleBatchRemoveTag(name);
                }}
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
