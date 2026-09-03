import {
    startTransition,
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
    ManageToolsHub,
    isManageToolSection,
    manageSectionTitle,
    type ManageSection,
} from "@/components/manage/ManageHub";
import { ManageArchivedPanel } from "@/components/manage/ManageArchivedPanel";
import { ManageTrashPanel } from "@/components/manage/ManageTrashPanel";
import { ManageUsagePanel } from "@/components/manage/ManageUsagePanel";
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
    clustersToSimilarityGroups,
    defaultSimilarityThreshold,
    indexableFiles,
    mergeCropMatches,
    similarityGroupToSelection,
    toStage1Items,
    trimSimilarityGroups,
    type SimilarMatchProgress,
    type SimilarityGroup,
} from "@/lib/similarity-groups";
import {
    imageFilesForPhash,
    runPhashJob,
    runStage1InWorker,
    terminatePhashWorker,
} from "@/lib/similarity-job";
import {
    EDGE_COLLECT_THRESHOLD,
    clusterFromFileEdges,
} from "@/lib/similarity-stage1-core";
import {
    getCachedStage1Edges,
    setCachedStage1Edges,
    similarityIndexKey,
} from "@/lib/similarity-match-cache";
import { APP_VERSION } from "@/lib/app-version";
import {
    isSessionAuthenticated,
    reconcileSessionWithCore,
    useSessionStore,
} from "@/stores/session-store";
import { useLibraryStore } from "@/stores/library-store";
import { usePhashIndexStore } from "@/stores/phash-index-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePhashJobStore, useUIStore } from "@/stores/ui-store";

const formatBytes = (bytes: number): string => {
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const parseManageSection = (value: string | string[] | undefined): ManageSection => {
    if (
        value === "tools" ||
        value === "exact" ||
        value === "similar" ||
        value === "compress" ||
        value === "archived" ||
        value === "trash" ||
        value === "auto-crop" ||
        value === "tags" ||
        value === "usage" ||
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
    const similarMaxGroupSize = useSettingsStore((s) => s.similarMaxGroupSize);
    const similarMaxGroupSizeRef = useRef(similarMaxGroupSize);
    similarMaxGroupSizeRef.current = similarMaxGroupSize;

    const [section, setSection] = useState<ManageSection>("hub");
    const [selections, setSelections] = useState<DedupGroupSelection[]>([]);
    const [threshold, setThreshold] = useState<number>(
        defaultSimilarityThreshold,
    );
    // The slider updates live while dragging; grouping only recomputes after
    // the user pauses, so moving the thumb doesn't re-run dHash grouping and
    // worker crop matches on every tick.
    const [debouncedThreshold, setDebouncedThreshold] = useState<number>(
        defaultSimilarityThreshold,
    );
    const thresholdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
    const [isPruning, setIsPruning] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>();
    const [similarGroups, setSimilarGroups] = useState<SimilarityGroup[]>([]);
    const [similarBusy, setSimilarBusy] = useState<boolean>(false);
    const [similarProgress, setSimilarProgress] = useState<
        SimilarMatchProgress | undefined
    >(undefined);
    /** >0 means the user asked to find similar groups; 0 = idle until they tap Find. */
    const [similarFindGeneration, setSimilarFindGeneration] = useState<number>(0);
    const initialLoadDone = useLibraryBootstrap({ afterSync: hydratePhash });

    const jobAbort = useRef<AbortController | undefined>(undefined);
    const jobPaused = useRef<boolean>(false);
    const cropMergeAbort = useRef<AbortController | undefined>(undefined);
    /** Uncapped groups from the last similar find (trim for display / max-size). */
    const lastFullSimilarGroups = useRef<SimilarityGroup[]>([]);

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
            if (thresholdTimer.current) {
                clearTimeout(thresholdTimer.current);
            }
            jobAbort.current?.abort();
            cropMergeAbort.current?.abort();
            terminatePhashWorker();
        };
    }, []);

    const dedupMode = section === "exact" || section === "similar" ? section : null;

    // Exact duplicates are cheap, but still skip them until the Exact section
    // is open — Manage hub / tags / trash must stay instant.
    const exactGroups = useMemo(() => {
        if (dedupMode !== "exact") {
            return [];
        }
        return findExactDuplicateGroups(allFiles, collections, userId);
    }, [dedupMode, allFiles, collections, userId]);

    // Similar: Stage-1 then async crop merge — only after the user taps Find
    // similar. Edge + crop verdict caches make later threshold changes cheap.
    useEffect(() => {
        cropMergeAbort.current?.abort();
        cropMergeAbort.current = undefined;

        if (dedupMode !== "similar") {
            setSimilarFindGeneration(0);
            setSimilarGroups([]);
            setSimilarBusy(false);
            setSimilarProgress(undefined);
            lastFullSimilarGroups.current = [];
            return;
        }

        if (similarFindGeneration === 0) {
            setSimilarGroups([]);
            setSimilarBusy(false);
            setSimilarProgress(undefined);
            lastFullSimilarGroups.current = [];
            return;
        }

        const abort = new AbortController();
        cropMergeAbort.current = abort;
        let cancelled = false;

        const filesById = new Map(allFiles.map((file) => [file.id, file]));
        const indexed = indexableFiles(
            phashEntries,
            filesById,
            collections,
            userId,
        );
        const stage1Items = toStage1Items(indexed);
        const indexKey = similarityIndexKey(stage1Items);
        const cachedEdges = getCachedStage1Edges(
            indexKey,
            EDGE_COLLECT_THRESHOLD,
        );
        const fromCache = Boolean(cachedEdges);

        // Cache hit: keep current groups visible while reclustering (no flash).
        setSimilarBusy(true);
        setSimilarProgress(
            fromCache ?
                {
                    stepDescription: "Grouping from cache",
                    completed: 1,
                    total: 1,
                } :
                undefined,
        );
        if (!fromCache) {
            setSimilarGroups([]);
        }

        const run = async (): Promise<void> => {
            if (!fromCache) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            if (abort.signal.aborted || cancelled) {
                return;
            }

            try {
                const showTrimmed = (full: SimilarityGroup[]): void => {
                    lastFullSimilarGroups.current = full;
                    startTransition(() => {
                        setSimilarGroups(
                            trimSimilarityGroups(
                                full,
                                similarMaxGroupSizeRef.current,
                            ),
                        );
                    });
                };

                const applyClusters = (
                    clusters: Parameters<typeof clustersToSimilarityGroups>[0],
                ): SimilarityGroup[] => {
                    const full = clustersToSimilarityGroups(
                        clusters,
                        filesById,
                        collections,
                        userId,
                    );
                    showTrimmed(full);
                    return full;
                };

                let stage1Clusters: Parameters<
                    typeof clustersToSimilarityGroups
                >[0];
                if (cachedEdges) {
                    stage1Clusters = clusterFromFileEdges(
                        stage1Items,
                        cachedEdges,
                        debouncedThreshold,
                    );
                } else {
                    setSimilarProgress({
                        stepDescription: "Comparing hashes",
                        completed: 0,
                        total: Math.max(indexed.length, 1),
                    });
                    const stage1Result = await runStage1InWorker(
                        stage1Items,
                        debouncedThreshold,
                        {
                            signal: abort.signal,
                            onProgress: (update) => {
                                if (abort.signal.aborted || cancelled) {
                                    return;
                                }
                                const stepDescription =
                                    update.phase === "comparing" ?
                                        "Comparing hashes" :
                                        update.phase === "finalizing" ?
                                            "Finalizing groups" :
                                            "Hash grouping done";
                                setSimilarProgress({
                                    stepDescription,
                                    completed: update.completed,
                                    total: Math.max(update.total, 1),
                                });
                                if (update.clusters !== undefined) {
                                    applyClusters(update.clusters);
                                }
                            },
                        },
                    );
                    if (abort.signal.aborted || cancelled) {
                        return;
                    }
                    setCachedStage1Edges(
                        indexKey,
                        EDGE_COLLECT_THRESHOLD,
                        stage1Result.edges,
                    );
                    stage1Clusters = stage1Result.clusters;
                }
                if (abort.signal.aborted || cancelled) {
                    return;
                }
                const stage1 = applyClusters(stage1Clusters);

                const merged = await mergeCropMatches(stage1, {
                    entries: phashEntries,
                    filesById,
                    collections,
                    userId,
                    signal: abort.signal,
                    maxGroupSize: similarMaxGroupSizeRef.current,
                    onProgress: (progress) => {
                        if (abort.signal.aborted || cancelled) {
                            return;
                        }
                        setSimilarProgress(progress);
                    },
                    onGroups: (groups) => {
                        if (abort.signal.aborted || cancelled) {
                            return;
                        }
                        startTransition(() => {
                            setSimilarGroups(groups);
                        });
                    },
                });
                if (abort.signal.aborted || cancelled) {
                    return;
                }
                lastFullSimilarGroups.current = merged;
                setSimilarGroups(
                    trimSimilarityGroups(
                        merged,
                        similarMaxGroupSizeRef.current,
                    ),
                );
                setSimilarProgress(undefined);
            } catch (mergeError: unknown) {
                if (
                    mergeError instanceof DOMException &&
                    mergeError.name === "AbortError"
                ) {
                    return;
                }
                throw mergeError;
            } finally {
                if (!cancelled && !abort.signal.aborted) {
                    setSimilarBusy(false);
                }
            }
        };

        void run().catch((runError: unknown) => {
            if (!cancelled && !abort.signal.aborted) {
                setSimilarBusy(false);
                setError(
                    runError instanceof Error ?
                        runError.message :
                        "Similar-photo scan failed",
                );
            }
        });

        return (): void => {
            cancelled = true;
            abort.abort();
        };
    }, [
        dedupMode,
        allFiles,
        collections,
        phashEntries,
        debouncedThreshold,
        similarFindGeneration,
        userId,
    ]);

    // Max group size only re-slices the last uncapped result — no rematch.
    useEffect(() => {
        if (dedupMode !== "similar" || similarFindGeneration === 0) {
            return;
        }
        if (lastFullSimilarGroups.current.length === 0) {
            return;
        }
        setSimilarGroups(
            trimSimilarityGroups(
                lastFullSimilarGroups.current,
                similarMaxGroupSize,
            ),
        );
    }, [dedupMode, similarFindGeneration, similarMaxGroupSize]);

    useEffect(() => {
        if (dedupMode === "exact") {
            setSelections(exactGroups.map((group) => exactGroupToSelection(group)));
        } else if (dedupMode === "similar") {
            setSelections(
                similarGroups.map((group) => similarityGroupToSelection(group)),
            );
        } else {
            setSelections([]);
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

    const handleBack = (): void => {
        if (isManageToolSection(section)) {
            setSection("tools");
            void router.replace(
                { pathname: "/manage", query: { section: "tools" } },
                undefined,
                { shallow: true },
            );
            return;
        }
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

    const similarProgressPercent =
        similarProgress && similarProgress.total > 0 ?
            Math.round(
                (similarProgress.completed / similarProgress.total) * 100,
            ) :
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
            onBack={section === "hub" ? undefined : handleBack}
        >
            <SyncBanner />

            {section === "hub" ? (
                <ManageHub onSelect={handleSelectSection} />
            ) : null}

            {section === "tools" ? (
                <ManageToolsHub onSelect={handleSelectSection} />
            ) : null}

            {section === "tags" ? <ManageTagsPanel /> : null}

            {section === "settings" ? <ManageSettingsPanel /> : null}

            {section === "usage" ? <ManageUsagePanel /> : null}

            {section === "archived" ? (
                <ManageArchivedPanel files={allFiles} />
            ) : null}

            {section === "trash" ? <ManageTrashPanel /> : null}

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
                    <div className="flex shrink-0 flex-col gap-3 px-4 pt-3">
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
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => {
                                            setSimilarFindGeneration((n) => n + 1);
                                        }}
                                        disabled={
                                            similarBusy ||
                                            !phashHydrated ||
                                            phashIndexedCount < 2
                                        }
                                    >
                                        {similarFindGeneration > 0 && !similarBusy ?
                                            "Find again" :
                                            "Find similar"}
                                    </Button>
                                    {similarBusy ? (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => {
                                                cropMergeAbort.current?.abort();
                                                setSimilarFindGeneration(0);
                                                setSimilarBusy(false);
                                                setSimilarProgress(undefined);
                                                setSimilarGroups([]);
                                            }}
                                        >
                                            Cancel
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
                                                if (thresholdTimer.current) {
                                                    clearTimeout(thresholdTimer.current);
                                                }
                                                thresholdTimer.current = setTimeout(() => {
                                                    setDebouncedThreshold(next);
                                                }, 300);
                                            }
                                        }}
                                    />
                                </Field>
                                <p className="text-xs text-muted-foreground">
                                    Indexed {phashIndexedCount} / {phashCandidateCount} images
                                    · {similarGroups.length} similar group
                                    {similarGroups.length === 1 ? "" : "s"}
                                    {similarBusy && similarProgress ?
                                        ` · ${similarProgress.stepDescription}` :
                                        similarBusy ?
                                            " · matching…" :
                                            ""}
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
                                {similarBusy && similarProgress ? (
                                    <div className="flex flex-col gap-1">
                                        <Progress
                                            value={similarProgressPercent}
                                            className="h-1"
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            {similarProgress.stepDescription}{" "}
                                            {similarProgress.completed} /{" "}
                                            {similarProgress.total}
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
                                        similarBusy ?
                                            "Finding similar photos…" :
                                            similarFindGeneration === 0 ?
                                                phashIndexedCount < 2 ?
                                                    "Scan your library" :
                                                    "Ready when you are" :
                                                phashIndexedCount < 2 ?
                                                    "Scan your library" :
                                                    "No similar groups"}
                                </EmptyTitle>
                                <EmptyDescription>
                                    {dedupMode === "exact" ?
                                        "No exact duplicates found in your library." :
                                        similarBusy ?
                                            "Comparing photos — groups appear as matches are found." :
                                            similarFindGeneration === 0 ?
                                                phashIndexedCount < 2 ?
                                                    "Scan your library to hash photos, then tap Find similar." :
                                                    "Hash new photos with Scan library if needed, then tap Find similar." :
                                                phashIndexedCount < 2 ?
                                                    "Scan your library to find similar photos." :
                                                    "No similar groups at this threshold."}
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    ) : null}

                    {!showFullPageLoader && selections.length > 0 ? (
                        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3 pb-24">
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

            <p className="px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] text-center text-[11px] text-muted-foreground/70">
                NTPhotos {APP_VERSION}
            </p>
        </AppShell>
    );
}
