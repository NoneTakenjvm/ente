import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
    type ReactNode,
} from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PageLoader } from "@/components/PageLoader";
import { DedupGroupCard } from "@/components/dedup/DedupGroupCard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import {
    dedupGroupMembersKey,
    planDuplicateGroupPrune,
    type DedupGroupChoice,
    type DedupGroupSelection,
} from "@/lib/dedup-prune";
import { errorMessage, plural } from "@/lib/format";
import { useLibraryStore } from "@/stores/library-store";

/** Duplicate groups rendered per page; each card keeps its thumbnails mounted. */
const groupPageSize = 50;

interface DedupGroupReviewProps {
    /** Groups to review; keeper and checkbox edits survive a new `groups` array. */
    groups: DedupGroupSelection[];
    /** Controls rendered above the dry-run checkbox, given the current selections. */
    children: (selections: DedupGroupSelection[]) => ReactNode;
    /** Error from the panel's own scan, shown alongside cleanup errors. */
    scanError?: string;
    showLoader: boolean;
    emptyTitle: string;
    emptyDescription: string;
    groupSubtitle: (group: DedupGroupSelection) => string;
}

/**
 * Group cards, dry-run toggle, and the prune confirmation shared by the
 * Exact duplicates and Similar photos panels.
 */
export function DedupGroupReview({
    groups,
    children,
    scanError,
    showLoader,
    emptyTitle,
    emptyDescription,
    groupSubtitle,
}: DedupGroupReviewProps): JSX.Element {
    const pruneDuplicateGroups = useLibraryStore((s) => s.pruneDuplicateGroups);

    const [selections, setSelections] = useState<DedupGroupSelection[]>([]);
    /**
     * Keeper and checkbox edits by {@link dedupGroupMembersKey}, so a regroup
     * (threshold, max size, progress emits) keeps them for unchanged groups.
     */
    const groupChoices = useRef(new Map<string, DedupGroupChoice>());
    const [dryRun, setDryRun] = useState<boolean>(false);
    const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
    const [isPruning, setIsPruning] = useState<boolean>(false);
    const [pruneError, setPruneError] = useState<string | undefined>();
    const [shownGroupCount, setShownGroupCount] =
        useState<number>(groupPageSize);

    useEffect(() => {
        setSelections(
            groups.map((group) => ({
                ...group,
                ...groupChoices.current.get(dedupGroupMembersKey(group.items)),
            })),
        );
        // A new scan or threshold starts from the first page again.
        setShownGroupCount(groupPageSize);
    }, [groups]);

    const selectedGroups = useMemo(
        () => selections.filter((group) => group.isSelected),
        [selections],
    );

    const prunePlan = useMemo(
        () => planDuplicateGroupPrune(selectedGroups),
        [selectedGroups],
    );

    const updateGroupChoice = useCallback(
        (target: DedupGroupSelection, choice: DedupGroupChoice): void => {
            const key = dedupGroupMembersKey(target.items);
            groupChoices.current.set(key, {
                ...groupChoices.current.get(key),
                ...choice,
            });
            setSelections((current) =>
                current.map((group) =>
                    group.id === target.id ? { ...group, ...choice } : group));
        },
        [],
    );

    const handleConfirmPrune = async (): Promise<void> => {
        setIsPruning(true);
        setPruneError(undefined);
        try {
            await pruneDuplicateGroups(selectedGroups, { dryRun });
            setConfirmOpen(false);
            if (!dryRun) {
                setSelections([]);
            }
        } catch (error: unknown) {
            setPruneError(errorMessage(error, "Cleanup failed"));
        } finally {
            setIsPruning(false);
        }
    };

    const error = pruneError ?? scanError;

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-col gap-3 px-4 pt-3">
                {children(selections)}

                <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                        checked={dryRun}
                        onCheckedChange={(checked) => setDryRun(checked === true)}
                    />
                    Dry run (preview only, no trash)
                </label>
            </div>

            {error ? (
                <Alert variant="destructive" className="mx-4 mt-3">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            ) : null}

            {showLoader ? (
                <PageLoader message="Loading your library…" />
            ) : null}

            {!showLoader && selections.length === 0 ? (
                <Empty className="flex-1 border-0">
                    <EmptyHeader>
                        <EmptyTitle>{emptyTitle}</EmptyTitle>
                        <EmptyDescription>{emptyDescription}</EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : null}

            {!showLoader && selections.length > 0 ? (
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3 pb-24">
                    {selections.slice(0, shownGroupCount).map((group) => (
                        <DedupGroupCard
                            key={group.id}
                            items={group.items.map((item) => item.file)}
                            keeperFileId={group.keeperFileId}
                            isSelected={group.isSelected}
                            subtitle={groupSubtitle(group)}
                            onToggleSelected={() =>
                                updateGroupChoice(group, {
                                    isSelected: !group.isSelected,
                                })
                            }
                            onSelectKeeper={(fileId) =>
                                updateGroupChoice(group, {
                                    keeperFileId: fileId,
                                })
                            }
                        />
                    ))}
                    {selections.length > shownGroupCount ? (
                        <Button
                            type="button"
                            variant="outline"
                            className="w-full"
                            onClick={() =>
                                setShownGroupCount(
                                    (count) => count + groupPageSize,
                                )
                            }
                        >
                            Show more
                        </Button>
                    ) : null}
                </div>
            ) : null}

            {selectedGroups.length > 0 ? (
                <footer className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
                    <Button
                        type="button"
                        className="w-full"
                        disabled={prunePlan.filesToTrash.length === 0}
                        onClick={() => setConfirmOpen(true)}
                    >
                        Review cleanup ({prunePlan.filesToTrash.length})
                    </Button>
                </footer>
            ) : null}

            <ConfirmDialog
                open={confirmOpen}
                title={dryRun ? "Preview cleanup" : "Move duplicates to trash?"}
                description={
                    <>
                        {dryRun ?
                            "Dry run enabled — no files will be changed." :
                            null}
                        {plural(prunePlan.filesToTrash.length, "file")} will be
                        moved to trash.
                        {prunePlan.collectionsToLink.size > 0 ?
                            ` ${plural(prunePlan.collectionsToLink.size, "album link")} will be added so keepers stay visible where copies were.` :
                            ""}
                    </>
                }
                confirmLabel={dryRun ? "Close preview" : "Move to trash"}
                destructive={!dryRun}
                isWorking={isPruning}
                confirmDisabled={prunePlan.filesToTrash.length === 0}
                onCancel={() => setConfirmOpen(false)}
                onConfirm={() => {
                    void handleConfirmPrune();
                }}
            />
        </div>
    );
}
