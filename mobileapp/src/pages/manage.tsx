import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import { useRouter } from "next/router";
import { AppShell } from "@/components/AppShell";
import { ManageCompressPanel } from "@/components/manage/ManageCompressPanel";
import {
    ManageHub,
    manageSectionTitle,
    type ManageSection,
} from "@/components/manage/ManageHub";
import { ManageArchivedPanel } from "@/components/manage/ManageArchivedPanel";
import { ManageAutoCropPanel } from "@/components/manage/ManageAutoCropPanel";
import { ManageSettingsPanel } from "@/components/manage/ManageSettingsPanel";
import { ManageTagsPanel } from "@/components/manage/ManageTagsPanel";
import { PageLoader } from "@/components/PageLoader";
import { ConfirmTrashModal } from "@/components/dedup/ConfirmTrashModal";
import { DedupGroupCard } from "@/components/dedup/DedupGroupCard";
import { SyncBanner } from "@/components/SyncBanner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { useLibraryBootstrap } from "@/hooks/use-library-bootstrap";
import {
    exactGroupToSelection,
    findExactDuplicateGroups,
    sumPrunableStats,
} from "@/lib/exact-duplicates";
import {
    planDuplicateGroupPrune,
    type DedupGroupSelection,
} from "@/lib/dedup-prune";
import {
    buildSimilarityGroups,
    defaultSimilarityThreshold,
    similarityGroupToSelection,
} from "@/lib/similarity-groups";
import {
    imageFilesForPhash,
    runPhashJob,
    terminatePhashWorker,
} from "@/lib/similarity-job";
import {
    isSessionAuthenticated,
    reconcileSessionWithCore,
    useSessionStore,
} from "@/stores/session-store";
import { useLibraryStore } from "@/stores/library-store";
import { usePhashIndexStore } from "@/stores/phash-index-store";
import { usePhashJobStore, useUIStore } from "@/stores/ui-store";

const formatBytes = (bytes: number): string => {
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const parseManageSection = (value: string | string[] | undefined): ManageSection => {
    if (
        value === "exact" ||
        value === "similar" ||
        value === "compress" ||
        value === "archived" ||
        value === "auto-crop" ||
        value === "tags" ||
        value === "settings"
    ) {
        return value;
    }
    return "hub";
};

export default function ManagePage(): JSX.Element {
    const router = useRouter();
    const email = useSessionStore((s) => s.email);
    const userId = useSessionStore((s) => s.userID) ?? 0;

    const allFiles = useLibraryStore((s) => s.allFiles);
    const collections = useLibraryStore((s) => s.collections);
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const pruneDuplicateGroupsAction = useLibraryStore(
        (s) => s.pruneDuplicateGroups,
    );

    const phashEntries = usePhashIndexStore((s) => s.entries);
    const phashHydrated = usePhashIndexStore((s) => s.isHydrated);
    const hydratePhash = usePhashIndexStore((s) => s.hydrate);
    const setPhashEntries = usePhashIndexStore((s) => s.setEntries);

    const phashJobStatus = usePhashJobStore((s) => s.status);
    const phashProgress = usePhashJobStore((s) => s.progress);
    const setPhashJobStatus = usePhashJobStore((s) => s.setStatus);
    const setPhashProgress = usePhashJobStore((s) => s.setProgress);
    const setPhashJobError = usePhashJobStore((s) => s.setError);

    const dedupDryRun = useUIStore((s) => s.dedupDryRun);
    const setDedupDryRun = useUIStore((s) => s.setDedupDryRun);

    const [section, setSection] = useState<ManageSection>("hub");
    const [selections, setSelections] = useState<DedupGroupSelection[]>([]);
    const [threshold, setThreshold] = useState<number>(
        defaultSimilarityThreshold,
    );
    const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
    const [isPruning, setIsPruning] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>();
    const initialLoadDone = useLibraryBootstrap({ afterSync: hydratePhash });

    const jobAbort = useRef<AbortController | undefined>(undefined);
    const jobPaused = useRef<boolean>(false);

    useEffect(() => {
        reconcileSessionWithCore();
        if (!isSessionAuthenticated()) {
            void router.replace("/login");
        }
    }, [router]);

    useEffect(() => {
        if (!router.isReady) {
            return;
        }
        setSection(parseManageSection(router.query.section));
    }, [router.isReady, router.query.section]);

    useEffect(() => {
        return (): void => {
            jobAbort.current?.abort();
            terminatePhashWorker();
        };
    }, []);

    const exactGroups = useMemo(
        () => findExactDuplicateGroups(allFiles, collections, userId),
        [allFiles, collections, userId],
    );

    const similarGroups = useMemo(() => {
        const filesById = new Map(allFiles.map((file) => [file.id, file]));
        return buildSimilarityGroups(
            phashEntries,
            filesById,
            collections,
            userId,
            threshold,
        );
    }, [allFiles, collections, phashEntries, threshold, userId]);

    const dedupMode = section === "exact" || section === "similar" ? section : null;

    useEffect(() => {
        if (dedupMode === "exact") {
            setSelections(exactGroups.map((group) => exactGroupToSelection(group)));
        } else if (dedupMode === "similar") {
            setSelections(
                similarGroups.map((group) => similarityGroupToSelection(group)),
            );
        }
    }, [dedupMode, exactGroups, similarGroups]);

    const selectedGroups = useMemo(
        () => selections.filter((group) => group.isSelected),
        [selections],
    );

    const prunePlan = useMemo(
        () => planDuplicateGroupPrune(selectedGroups),
        [selectedGroups],
    );

    const exactStats = useMemo(() => {
        const selectedFlags = selections.map((group) => group.isSelected);
        return sumPrunableStats(exactGroups, selectedFlags);
    }, [exactGroups, selections]);

    const phashCandidateCount = useMemo(
        () => imageFilesForPhash(allFiles, userId).length,
        [allFiles, userId],
    );

    const phashIndexedCount = phashEntries.size;

    const updateSelection = useCallback(
        (groupId: string, updater: (group: DedupGroupSelection) => DedupGroupSelection): void => {
            setSelections((current) =>
                current.map((group) =>
                    group.id === groupId ? updater(group) : group));
        },
        [],
    );

    const handleStartPhashJob = (): void => {
        if (phashJobStatus === "running") {
            return;
        }

        jobAbort.current?.abort();
        jobAbort.current = new AbortController();
        jobPaused.current = false;
        setPhashJobError(undefined);
        setPhashJobStatus("running");

        const candidates = imageFilesForPhash(allFiles, userId);
        const pending = candidates.filter((file) => !phashEntries.has(file.id));
        setPhashProgress(0, pending.length);

        void runPhashJob({
            files: candidates,
            entries: new Map(phashEntries),
            signal: jobAbort.current.signal,
            shouldPause: () => jobPaused.current,
            onProgress: (current, total) => {
                setPhashProgress(current, total);
            },
        })
            .then((entries) => {
                setPhashEntries(entries);
                setPhashJobStatus("done");
            })
            .catch((jobError: unknown) => {
                if (jobAbort.current?.signal.aborted) {
                    setPhashJobStatus("paused");
                    return;
                }
                setPhashJobStatus("error");
                setPhashJobError(
                    jobError instanceof Error ?
                        jobError.message :
                        "Similarity scan failed",
                );
            });
    };

    const handlePausePhashJob = (): void => {
        jobPaused.current = true;
        jobAbort.current?.abort();
        setPhashJobStatus("paused");
    };

    const handleConfirmPrune = async (): Promise<void> => {
        setIsPruning(true);
        setError(undefined);
        try {
            await pruneDuplicateGroupsAction(selectedGroups, {
                dryRun: dedupDryRun,
            });
            setConfirmOpen(false);
            if (!dedupDryRun) {
                setSelections([]);
            }
        } catch (pruneError: unknown) {
            setError(
                pruneError instanceof Error ?
                    pruneError.message :
                    "Cleanup failed",
            );
        } finally {
            setIsPruning(false);
        }
    };

    const handleSelectSection = (next: Exclude<ManageSection, "hub">): void => {
        setSection(next);
        void router.replace(
            { pathname: "/manage", query: { section: next } },
            undefined,
            { shallow: true },
        );
    };

    const handleBackToHub = (): void => {
        setSection("hub");
        void router.replace("/manage", undefined, { shallow: true });
    };

    const showFullPageLoader =
        !initialLoadDone &&
        (syncStatus === "loadingFromCache" || syncStatus === "syncing");

    const progressPercent =
        phashProgress.total > 0 ?
            Math.round((phashProgress.current / phashProgress.total) * 100) :
            0;

    const showCompressLoader =
        section === "compress" &&
        !initialLoadDone &&
        (syncStatus === "loadingFromCache" || syncStatus === "syncing");

    const shellTitle =
        section === "hub" ? "Manage" : manageSectionTitle(section);

    if (!isSessionAuthenticated()) {
        return <PageLoader message="Redirecting to sign in…" />;
    }

    return (
        <AppShell
            title={shellTitle}
            email={email}
            onBack={section === "hub" ? undefined : handleBackToHub}
        >
            <SyncBanner />

            {section === "hub" ? (
                <ManageHub onSelect={handleSelectSection} />
            ) : null}

            {section === "tags" ? <ManageTagsPanel /> : null}

            {section === "settings" ? <ManageSettingsPanel /> : null}

            {section === "archived" ? (
                <ManageArchivedPanel files={allFiles} />
            ) : null}

            {section === "auto-crop" ? (
                <ManageAutoCropPanel files={allFiles} />
            ) : null}

            {section === "compress" ? (
                showCompressLoader ? (
                    <PageLoader message="Loading your library…" />
                ) : (
                    <ManageCompressPanel
                        files={allFiles}
                        libraryLoaded={initialLoadDone}
                    />
                )
            ) : null}

            {dedupMode ? (
                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex flex-col gap-3 px-4 pt-3">
                        {dedupMode === "exact" ? (
                            <p className="text-xs text-muted-foreground">
                                {exactGroups.length} duplicate group
                                {exactGroups.length === 1 ? "" : "s"} ·{" "}
                                {exactStats.count} file
                                {exactStats.count === 1 ? "" : "s"} selected · ~
                                {formatBytes(exactStats.size)} reclaimable
                            </p>
                        ) : (
                            <>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        type="button"
                                        size="sm"
                                        onClick={handleStartPhashJob}
                                        disabled={
                                            phashJobStatus === "running" ||
                                            !phashHydrated ||
                                            phashIndexedCount >= phashCandidateCount
                                        }
                                    >
                                        {phashIndexedCount >= phashCandidateCount &&
                                        phashCandidateCount > 0 ?
                                            "Scan complete" :
                                            phashJobStatus === "paused" ?
                                                "Resume scan" :
                                                "Scan library"}
                                    </Button>
                                    {phashJobStatus === "running" ? (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={handlePausePhashJob}
                                        >
                                            Pause
                                        </Button>
                                    ) : null}
                                </div>
                                <Field>
                                    <FieldLabel htmlFor="similarity-threshold">
                                        Threshold: {threshold}
                                    </FieldLabel>
                                    <Slider
                                        id="similarity-threshold"
                                        min={4}
                                        max={20}
                                        value={[threshold]}
                                        onValueChange={(value) => {
                                            const next = Array.isArray(value) ? value[0] : value;
                                            if (next !== undefined) {
                                                setThreshold(next);
                                            }
                                        }}
                                    />
                                </Field>
                                <p className="text-xs text-muted-foreground">
                                    Indexed {phashIndexedCount} / {phashCandidateCount} images
                                    · {similarGroups.length} similar group
                                    {similarGroups.length === 1 ? "" : "s"}
                                </p>
                                {phashJobStatus === "running" ? (
                                    <div className="flex flex-col gap-1">
                                        <Progress value={progressPercent} className="h-1" />
                                        <span className="text-xs text-muted-foreground">
                                            Scanning {phashProgress.current} /{" "}
                                            {phashProgress.total}
                                        </span>
                                    </div>
                                ) : null}
                            </>
                        )}

                        <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                                checked={dedupDryRun}
                                onCheckedChange={(checked) =>
                                    setDedupDryRun(checked === true)
                                }
                            />
                            Dry run (preview only, no trash)
                        </label>
                    </div>

                    {error ? (
                        <Alert variant="destructive" className="mx-4 mt-3">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    ) : null}

                    {showFullPageLoader ? (
                        <PageLoader message="Loading your library…" />
                    ) : null}

                    {!showFullPageLoader && selections.length === 0 ? (
                        <Empty className="flex-1 border-0">
                            <EmptyHeader>
                                <EmptyTitle>
                                    {dedupMode === "exact" ?
                                        "No exact duplicates" :
                                        phashIndexedCount < 2 ?
                                            "Scan your library" :
                                            "No similar groups"}
                                </EmptyTitle>
                                <EmptyDescription>
                                    {dedupMode === "exact" ?
                                        "No exact duplicates found in your library." :
                                        phashIndexedCount < 2 ?
                                            "Scan your library to find similar photos." :
                                            "No similar groups at this threshold."}
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    ) : null}

                    {!showFullPageLoader && selections.length > 0 ? (
                        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 pb-24">
                            {selections.map((group) => (
                                <DedupGroupCard
                                    key={group.id}
                                    items={group.items.map((item) => item.file)}
                                    keeperFileId={group.keeperFileId}
                                    isSelected={group.isSelected}
                                    subtitle={
                                        dedupMode === "similar" ?
                                            group.items
                                                .map((item) => item.collectionName)
                                                .join(", ") :
                                            `~${formatBytes(
                                                (group.items.length - 1) *
                                                      (group.items[0]?.file.info
                                                          ?.fileSize ?? 0),
                                            )}`
                                    }
                                    onToggleSelected={() =>
                                        updateSelection(group.id, (current) => ({
                                            ...current,
                                            isSelected: !current.isSelected,
                                        }))
                                    }
                                    onSelectKeeper={(fileId) =>
                                        updateSelection(group.id, (current) => ({
                                            ...current,
                                            keeperFileId: fileId,
                                        }))
                                    }
                                />
                            ))}
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
                </div>
            ) : null}

            <ConfirmTrashModal
                open={confirmOpen}
                fileCount={prunePlan.filesToTrash.length}
                linkCount={prunePlan.collectionsToLink.size}
                dryRun={dedupDryRun}
                isWorking={isPruning}
                onCancel={() => setConfirmOpen(false)}
                onConfirm={() => {
                    void handleConfirmPrune();
                }}
            />
        </AppShell>
    );
}
