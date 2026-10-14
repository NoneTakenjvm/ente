import {
    useCallback,
    useMemo,
    useState,
    type JSX,
} from "react";
import { TagClausePicker } from "@/components/TagClausePicker";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { GalleryToolsMenu } from "@/components/GalleryToolsMenu";
import { SortMenu } from "@/components/SortMenu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
    countTagFilterClauses,
    describeTagFilter,
    isFlatTagFilterRoot,
    isTagFilterActive,
    type TagFilterSelection,
} from "@/lib/tag-filter";
import { bulkAddTags, bulkRemoveTags } from "@/lib/tag-bulk-actions";
import { Shuffle } from "lucide-react";
import { useLibraryStore } from "@/stores/library-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useScopeCounts } from "@/hooks/use-scope-counts";
import { useTagFilterBinding } from "@/hooks/use-tag-filter-binding";
import { useTagStore } from "@/stores/tag-store";
import type { TagFilterTarget } from "@/stores/tag-store";
import { useUIStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";
import { errorMessage, plural } from "@/lib/format";

interface TagFilterBarProps {
    matchCount: number;
    /** Files currently matching the active filter (visible set). */
    matchingFiles: EnteFile[];
    filterTarget?: TagFilterTarget;
    /** Files to count scope filters against; defaults to the full library. */
    scopeCandidateFiles?: EnteFile[];
    /** Filter whose clauses enable tag-fit sort (album query when refining). */
    tagFilterFitSource?: TagFilterSelection;
}

export function TagFilterBar({
    matchCount,
    matchingFiles,
    filterTarget = "gallery",
    scopeCandidateFiles,
    tagFilterFitSource,
}: TagFilterBarProps): JSX.Element {
    const allFiles = useLibraryStore((s) => s.allFiles);
    const knownTags = useTagStore((s) => s.tags);
    const { filter, actions } = useTagFilterBinding(filterTarget);
    const counts = useScopeCounts(scopeCandidateFiles ?? allFiles);

    const selectAll = useSelectionStore((s) => s.selectAll);
    const pinnedTags = useTagSpeedStore((s) => s.pinnedTags);
    const presets = useTagSpeedStore((s) => s.presets);
    const togglePinnedTag = useTagSpeedStore((s) => s.togglePinnedTag);

    const ordering = useUIStore((s) => s.ordering);
    const setOrdering = useUIStore((s) => s.setOrdering);

    const matchingFileIds = useMemo(
        () => matchingFiles.map((file) => file.id),
        [matchingFiles],
    );

    const [bulkTagOpen, setBulkTagOpen] = useState<boolean>(false);
    const [confirmBulkOpen, setConfirmBulkOpen] = useState<boolean>(false);
    const [pendingBulkTags, setPendingBulkTags] = useState<string[]>([]);
    const [bulkBusy, setBulkBusy] = useState<boolean>(false);
    const [bulkError, setBulkError] = useState<string | undefined>();

    const isShuffled = ordering?.kind === "shuffled";
    const filterActive = isTagFilterActive(filter);
    const clauseCount = countTagFilterClauses(filter.root);
    // Keep latched mode when clauses drop to zero; only hide the Sort radios.
    const tagFilterFitAvailable =
        countTagFilterClauses((tagFilterFitSource ?? filter).root) > 0;

    const tagsButtonLabel =
        clauseCount === 0 ? "Tags" : plural(clauseCount, "tag");

    const handleSelectAllMatching = useCallback((): void => {
        if (!matchingFileIds.length) {
            return;
        }
        selectAll(matchingFileIds);
    }, [matchingFileIds, selectAll]);

    const applyBulkTags = useCallback(
        async (tags: string[]): Promise<void> => {
            if (!tags.length || !matchingFileIds.length) {
                return;
            }
            setBulkBusy(true);
            setBulkError(undefined);
            try {
                await bulkAddTags(matchingFileIds, tags);
                setBulkTagOpen(false);
                setConfirmBulkOpen(false);
                setPendingBulkTags([]);
            } catch (error) {
                setBulkError(
                    errorMessage(error, "Could not tag matching photos"),
                );
            } finally {
                setBulkBusy(false);
            }
        },
        [matchingFileIds],
    );

    const requestBulkTags = useCallback(
        (tags: string[]): void => {
            if (matchCount > 25) {
                setPendingBulkTags(tags);
                setConfirmBulkOpen(true);
                return;
            }
            void applyBulkTags(tags);
        },
        [applyBulkTags, matchCount],
    );

    return (
        <>
            <div className="flex flex-col gap-2 border-b border-border/60 px-4 py-3">
                <div className="flex flex-nowrap items-center justify-center gap-2 overflow-x-auto">
                    <SortMenu
                        filter={filter}
                        setScope={actions.setScope}
                        counts={counts}
                        matchingFiles={matchingFiles}
                        tagFilterFitAvailable={tagFilterFitAvailable}
                    />
                    <TagClausePicker
                        filter={filter}
                        onSetTagFilterMode={actions.setTagFilterMode}
                        onSetKitMode={actions.setKitMode}
                        onSetRootOp={(op) => {
                            actions.setGroupOp(filter.root.id, op);
                        }}
                        triggerLabel={tagsButtonLabel}
                        triggerVariant={clauseCount > 0 ? "secondary" : "outline"}
                        disabled={!isFlatTagFilterRoot(filter.root)}
                    />
                    <Button
                        type="button"
                        variant={isShuffled ? "secondary" : "outline"}
                        size="sm"
                        className="gap-1.5"
                        aria-label={isShuffled ? "Disable random order" : "Randomise"}
                        aria-pressed={isShuffled}
                        onClick={() => {
                            setOrdering(
                                isShuffled ?
                                    undefined :
                                    {
                                        kind: "shuffled",
                                        seed: Date.now(),
                                        fileIds: [],
                                    },
                            );
                        }}
                    >
                        <Shuffle className="size-3.5 shrink-0" />
                        <span>Randomise</span>
                    </Button>
                    <GalleryToolsMenu filterTarget={filterTarget} counts={counts} />
                </div>
                {filterActive ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-muted-foreground">
                            {plural(matchCount, "photo")}
                            {" · "}
                            {describeTagFilter(filter)}
                        </span>
                        <div className="flex flex-wrap items-center gap-1">
                            {matchCount > 0 ? (
                                <>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="xs"
                                        onClick={handleSelectAllMatching}
                                    >
                                        Select all
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="xs"
                                        onClick={() => {
                                            setBulkError(undefined);
                                            setBulkTagOpen(true);
                                        }}
                                    >
                                        Tag matching…
                                    </Button>
                                </>
                            ) : null}
                            <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={actions.clearFilters}
                            >
                                Clear
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>

            <TagPickerSheet
                open={bulkTagOpen}
                appliedTags={[]}
                knownTags={knownTags}
                error={bulkError}
                presets={presets}
                kitScoreFiles={matchingFiles}
                defaultToKits={presets.length > 0}
                pinnedTags={pinnedTags}
                batchSelectionHint={
                    matchCount === 1 ?
                        "Add a kit or tags to the 1 matching photo." :
                        `Add a kit or tags to all ${matchCount} matching photos.`
                }
                onOpenChange={(open) => {
                    if (!open && !bulkBusy) {
                        setBulkTagOpen(false);
                        setBulkError(undefined);
                    }
                }}
                onAddTag={(name) => requestBulkTags([name])}
                onRemoveTag={(name) => {
                    void (async () => {
                        setBulkBusy(true);
                        try {
                            await bulkRemoveTags(matchingFileIds, [name]);
                        } catch (error) {
                            setBulkError(
                                errorMessage(error, "Could not remove tag"),
                            );
                        } finally {
                            setBulkBusy(false);
                        }
                    })();
                }}
                onApplyPreset={requestBulkTags}
                onTogglePinTag={togglePinnedTag}
            />

            <ConfirmDialog
                open={confirmBulkOpen}
                title={`Tag ${matchCount} matching photos?`}
                description={
                    <>
                        Apply{" "}
                        <span className="font-medium text-foreground">
                            {pendingBulkTags.join(", ")}
                        </span>{" "}
                        to every photo that matches the current filter. You can
                        undo from the toast afterward.
                    </>
                }
                confirmLabel="Tag all"
                isWorking={bulkBusy}
                onCancel={() => {
                    setConfirmBulkOpen(false);
                    setPendingBulkTags([]);
                }}
                onConfirm={() => {
                    void applyBulkTags(pendingBulkTags);
                }}
            />
        </>
    );
}
