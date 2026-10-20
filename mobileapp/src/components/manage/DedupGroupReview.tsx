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
import { DedupCompareDialog } from "@/components/dedup/DedupCompareDialog";
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
import { dedupGroupFacts } from "@/lib/dedup-facts";
import {
    dedupGroupMembersKey,
    planDuplicateGroupPrune,
    type DedupGroupChoice,
    type DedupGroupSelection,
} from "@/lib/dedup-prune";
import { errorMessage, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useQualityIndexStore } from "@/stores/quality-index-store";
import { ChevronDown } from "lucide-react";

/** Duplicate groups rendered per page; each card keeps its thumbnails mounted. */
const groupPageSize = 50;

interface DedupGroupReviewProps {
    /** Groups to review; keeper and checkbox edits survive a new `groups` array. */
    groups: DedupGroupSelection[];
    /** Setup controls, given the current selections. */
    children: (selections: DedupGroupSelection[]) => ReactNode;
    /**
     * When set, {@link children} sit in a collapsible section with this label
     * that folds away once results first appear.
     */
    setupLabel?: string;
    /** Controls kept visible above the results (e.g. a threshold slider). */
    toolbar?: ReactNode;
    /** What one group is called, for the result count. */
    groupNoun?: string;
    /** Error from the panel's own scan, shown alongside cleanup errors. */
    scanError?: string;
    showLoader: boolean;
    emptyTitle: string;
    emptyDescription: string;
    groupSubtitle: (group: DedupGroupSelection) => string;
    /** When set, each card gets an "Exempt pair" button that calls this. */
    onExemptGroup?: (group: DedupGroupSelection) => void;
}

/**
 * Group cards, compare view, cleanup bar and the prune confirmation shared by
 * the Exact duplicates and Similar photos panels.
 */
export function DedupGroupReview({
    groups,
    children,
    setupLabel,
    toolbar,
    groupNoun = "group",
    scanError,
    showLoader,
    emptyTitle,
    emptyDescription,
    groupSubtitle,
    onExemptGroup,
}: DedupGroupReviewProps): JSX.Element {
    const pruneDuplicateGroups = useLibraryStore((s) => s.pruneDuplicateGroups);
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    const qualityById = useQualityIndexStore((s) => s.entries);

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
    const [setupOpen, setSetupOpen] = useState<boolean>(true);
    const [comparedGroupId, setComparedGroupId] = useState<
        string | undefined
    >();
    const hadGroups = useRef(false);

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

    // Fold the setup away when the first results land.
    useEffect(() => {
        if (groups.length > 0 && !hadGroups.current) {
            setSetupOpen(false);
        }
        hadGroups.current = groups.length > 0;
    }, [groups.length]);

    const shownGroups = useMemo(
        () => selections.slice(0, shownGroupCount),
        [selections, shownGroupCount],
    );

    // Only the visible cards need their facts formatted.
    const factsByGroupId = useMemo(
        () =>
            new Map(
                shownGroups.map((group) => [
                    group.id,
                    dedupGroupFacts(
                        group.items.map((item) => item.file),
                        favoriteFileIds,
                        qualityById,
                    ),
                ]),
            ),
        [shownGroups, favoriteFileIds, qualityById],
    );

    const comparedGroup = selections.find(
        (group) => group.id === comparedGroupId,
    );

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

    const setAllSelected = (isSelected: boolean): void => {
        for (const group of selections) {
            const key = dedupGroupMembersKey(group.items);
            groupChoices.current.set(key, {
                ...groupChoices.current.get(key),
                isSelected,
            });
        }
        setSelections((current) =>
            current.map((group) => ({ ...group, isSelected })));
    };

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
                {setupLabel ? (
                    <div className="rounded-xl border border-border bg-card">
                        <button
                            type="button"
                            className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium"
                            aria-expanded={setupOpen}
                            onClick={() => setSetupOpen((open) => !open)}
                        >
                            {setupLabel}
                            <ChevronDown
                                className={cn(
                                    "size-4 transition-transform",
                                    setupOpen && "rotate-180",
                                )}
                            />
                        </button>
                        {setupOpen ? (
                            <div className="flex flex-col gap-3 border-t border-border p-3">
                                {children(selections)}
                            </div>
                        ) : null}
                    </div>
                ) : (
                    children(selections)
                )}
                {toolbar}
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
                <>
                    <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3">
                        <p className="text-xs text-muted-foreground">
                            {plural(selections.length, groupNoun)} ·{" "}
                            {selectedGroups.length} selected
                        </p>
                        <div className="flex gap-1">
                            <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                disabled={
                                    selectedGroups.length === selections.length
                                }
                                onClick={() => setAllSelected(true)}
                            >
                                Select all
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                disabled={selectedGroups.length === 0}
                                onClick={() => setAllSelected(false)}
                            >
                                Clear
                            </Button>
                        </div>
                    </div>
                    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3 pb-28">
                        {shownGroups.map((group) => (
                            <DedupGroupCard
                                key={group.id}
                                items={group.items.map((item) => item.file)}
                                facts={factsByGroupId.get(group.id) ?? []}
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
                                onCompare={() => setComparedGroupId(group.id)}
                                onExempt={
                                    onExemptGroup ?
                                        () => onExemptGroup(group) :
                                        undefined
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
                </>
            ) : null}

            {selectedGroups.length > 0 ? (
                <footer className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] flex items-center gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
                    <label className="flex shrink-0 items-center gap-2 text-sm">
                        <Checkbox
                            checked={dryRun}
                            onCheckedChange={(checked) =>
                                setDryRun(checked === true)}
                        />
                        Dry run
                    </label>
                    <Button
                        type="button"
                        className="flex-1"
                        disabled={prunePlan.filesToTrash.length === 0}
                        onClick={() => setConfirmOpen(true)}
                    >
                        Review cleanup ({prunePlan.filesToTrash.length})
                    </Button>
                </footer>
            ) : null}

            {comparedGroup ? (
                <DedupCompareDialog
                    files={comparedGroup.items.map((item) => item.file)}
                    facts={factsByGroupId.get(comparedGroup.id) ?? []}
                    keeperFileId={comparedGroup.keeperFileId}
                    onSelectKeeper={(fileId) =>
                        updateGroupChoice(comparedGroup, {
                            keeperFileId: fileId,
                        })
                    }
                    onClose={() => setComparedGroupId(undefined)}
                />
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
