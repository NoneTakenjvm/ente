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
    parseManageSection,
    type ManageSection,
} from "@/components/manage/ManageHub";
import { ManageArchivedPanel } from "@/components/manage/ManageArchivedPanel";
import { ManageTrashPanel } from "@/components/manage/ManageTrashPanel";
import { ManageUsagePanel } from "@/components/manage/ManageUsagePanel";
import { ManageAutoCropPanel } from "@/components/manage/ManageAutoCropPanel";
import { ManageSettingsPanel } from "@/components/manage/ManageSettingsPanel";
import { ManageTagsPanel } from "@/components/manage/ManageTagsPanel";
import { PageLoader } from "@/components/PageLoader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
    dedupGroupMembersKey,
    planDuplicateGroupPrune,
    type DedupGroupChoice,
    type DedupGroupSelection,
} from "@/lib/dedup-prune";
import {
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
    CLIP_SCORE_COLLECT_MAX,
    CLIP_SCORE_SLIDER_MAX,
    CLIP_SCORE_SLIDER_MIN,
    EDGE_COLLECT_THRESHOLD,
    clampClipScoreThreshold,
    clusterFromFileEdges,
    type Stage1Cluster,
} from "@/lib/similarity-stage1-core";
import {
    clearSimilarityMatchCache,
    getCachedStage1Edges,
    setCachedStage1Edges,
    similarityIndexKey,
} from "@/lib/similarity-match-cache";
import { APP_VERSION } from "@/lib/app-version";
import { useRequireSession } from "@/hooks/use-require-session";
import { useSessionStore } from "@/stores/session-store";
import { useLibraryStore } from "@/stores/library-store";
import { usePhashIndexStore } from "@/stores/phash-index-store";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useQualityIndexStore } from "@/stores/quality-index-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePhashJobStore, useUIStore } from "@/stores/ui-store";
import { errorMessage, formatFileSize, plural } from "@/lib/format";

/** Duplicate groups rendered per page; each card keeps its thumbnails mounted. */
const dedupGroupPageSize = 50;

export default function ManagePage(): JSX.Element {
    const router = useRouter();
    const { ready, authenticated } = useRequireSession();
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

    const embeddingEntries = useEmbeddingIndexStore((s) => s.entries);
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.hydrate);

    const hydrateQuality = useQualityIndexStore((s) => s.hydrate);
    const qualityById = useQualityIndexStore((s) => s.entries);
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);

    const phashJobStatus = usePhashJobStore((s) => s.status);
    const phashProgress = usePhashJobStore((s) => s.progress);
    const setPhashJobStatus = usePhashJobStore((s) => s.setStatus);
    const setPhashProgress = usePhashJobStore((s) => s.setProgress);

    const dedupDryRun = useUIStore((s) => s.dedupDryRun);
    const setDedupDryRun = useUIStore((s) => s.setDedupDryRun);
    const similarMaxGroupSize = useSettingsStore((s) => s.similarMaxGroupSize);
    const similarMaxGroupSizeRef = useRef(similarMaxGroupSize);
    similarMaxGroupSizeRef.current = similarMaxGroupSize;

    const [section, setSection] = useState<ManageSection>("hub");
    const [selections, setSelections] = useState<DedupGroupSelection[]>([]);
    /**
     * Keeper and checkbox edits by {@link dedupGroupMembersKey}, so a regroup
     * (threshold, max size, progress emits) keeps them for unchanged groups.
     */
    const groupChoices = useRef(new Map<string, DedupGroupChoice>());
    const [threshold, setThreshold] = useState(
        () => clampClipScoreThreshold(defaultSimilarityThreshold),
    );
    // The slider updates live while dragging; grouping only recomputes after
    // the user pauses, so moving the thumb doesn't re-run dHash grouping and
    // worker crop matches on every tick.
    const [debouncedThreshold, setDebouncedThreshold] = useState(
        () => clampClipScoreThreshold(defaultSimilarityThreshold),
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
    const [shownGroupCount, setShownGroupCount] = useState<number>(dedupGroupPageSize);
    const initialLoadDone = useLibraryBootstrap({
        afterSync: async (): Promise<void> => {
            await Promise.all([
                hydratePhash(),
                hydrateEmbeddings(),
                hydrateQuality(),
            ]);
        },
    });

    useEffect(() => {
        if (embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings]);

    const jobAbort = useRef<AbortController | undefined>(undefined);
    const jobPaused = useRef<boolean>(false);
    const cropMergeAbort = useRef<AbortController | undefined>(undefined);
    /** Uncapped groups from the last similar find (trim for display / max-size). */
    const lastFullSimilarGroups = useRef<SimilarityGroup[]>([]);

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
            // Drop session edge/crop caches when leaving Similar — they can
            // pin tens of thousands of verdicts and freeze/OOM the phone.
            clearSimilarityMatchCache();
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
        let clipOverlap = 0;
        // Cheap per-vector sample so a re-embedded file (same count) misses the cache.
        let clipFingerprint = 0;
        for (const item of stage1Items) {
            const vector = embeddingEntries.get(item.fileId);
            if (vector?.length) {
                clipOverlap += 1;
                clipFingerprint =
                    (Math.imul(clipFingerprint, 31) +
                        item.fileId +
                        Math.round(vector[0]! * 1e6) +
                        Math.round(vector[vector.length - 1]! * 1e3)) |
                    0;
            }
        }
        const useClip = clipOverlap >= 2;
        const indexKey =
            similarityIndexKey(stage1Items) +
            (useClip ? `|clip:${clipOverlap}:${clipFingerprint}` : "|hash");
        const collectThreshold = useClip ?
            CLIP_SCORE_COLLECT_MAX :
            EDGE_COLLECT_THRESHOLD;
        const cachedEdges = getCachedStage1Edges(indexKey, collectThreshold);
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

                // Progress bar only during the scan — mounting thousands of
                // DedupGroupCards (and their thumbs) mid-pass freezes the UI.
                let stage1Clusters: Stage1Cluster[];
                const clip =
                    useClip ? { embeddings: embeddingEntries } : undefined;
                if (cachedEdges) {
                    stage1Clusters = clusterFromFileEdges(
                        stage1Items,
                        cachedEdges,
                        debouncedThreshold,
                        clip,
                    );
                } else {
                    setSimilarProgress({
                        stepDescription:
                            clip ?
                                "Matching closest CLIP neighbours" :
                                "Comparing hashes",
                        completed: 0,
                        total: Math.max(indexed.length, 1),
                    });
                    const stage1Result = await runStage1InWorker(
                        stage1Items,
                        debouncedThreshold,
                        {
                            signal: abort.signal,
                            embeddings: clip?.embeddings,
                            onProgress: (update) => {
                                if (abort.signal.aborted || cancelled) {
                                    return;
                                }
                                const stepDescription =
                                    update.phase === "comparing" ?
                                        clip ?
                                            "Matching closest CLIP neighbours" :
                                            "Comparing hashes" :
                                        update.phase === "finalizing" ?
                                            "Finalizing groups" :
                                            "Grouping done";
                                setSimilarProgress({
                                    stepDescription,
                                    completed: update.completed,
                                    total: Math.max(update.total, 1),
                                });
                            },
                        },
                    );
                    if (abort.signal.aborted || cancelled) {
                        return;
                    }
                    setCachedStage1Edges(
                        indexKey,
                        collectThreshold,
                        stage1Result.edges,
                    );
                    stage1Clusters = stage1Result.clusters;
                }
                if (abort.signal.aborted || cancelled) {
                    return;
                }
                // Seed crop merge from raw clusters (including oversized) so UF
                // stays correct; assembly/display skips groups above the settings max.
                const merged = await mergeCropMatches([], {
                    entries: phashEntries,
                    filesById,
                    collections,
                    userId,
                    signal: abort.signal,
                    maxGroupSize: similarMaxGroupSizeRef.current,
                    stage1Clusters,
                    onProgress: (progress) => {
                        if (abort.signal.aborted || cancelled) {
                            return;
                        }
                        setSimilarProgress(progress);
                    },
                });
                if (abort.signal.aborted || cancelled) {
                    return;
                }
                showTrimmed(merged);
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
                    errorMessage(runError, "Similar-photo scan failed"),
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
        embeddingEntries,
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
        groupChoices.current.clear();
    }, [dedupMode]);

    useEffect(() => {
        const keeperContext = { favoriteFileIds, qualityById };
        const groups =
            dedupMode === "exact" ?
                exactGroups.map((group) =>
                    exactGroupToSelection(group, true, keeperContext)) :
                dedupMode === "similar" ?
                    similarGroups.map((group) =>
                        similarityGroupToSelection(group, false, keeperContext)) :
                    [];
        setSelections(
            groups.map((group) => ({
                ...group,
                ...groupChoices.current.get(dedupGroupMembersKey(group.items)),
            })),
        );
    }, [dedupMode, exactGroups, similarGroups, favoriteFileIds, qualityById]);

    // A new scan or threshold starts from the first page again.
    useEffect(() => {
        setShownGroupCount(dedupGroupPageSize);
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

    // Only the Similar section shows these counts; skip the scans otherwise.
    const phashCandidateCount = useMemo(
        () =>
            dedupMode === "similar" ?
                imageFilesForPhash(allFiles, userId).length :
                0,
        [dedupMode, allFiles, userId],
    );
    const phashIndexedCount = phashEntries.size;
    const clipCoverageOnIndexed = useMemo(() => {
        if (dedupMode !== "similar" || phashEntries.size === 0) {
            return 0;
        }
        let n = 0;
        for (const id of phashEntries.keys()) {
            if (embeddingEntries.has(id)) {
                n += 1;
            }
        }
        return n;
    }, [dedupMode, phashEntries, embeddingEntries]);

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

    const handleStartPhashJob = (): void => {
        if (phashJobStatus === "running") {
            return;
        }

        jobAbort.current?.abort();
        const controller = new AbortController();
        const { signal } = controller;
        jobAbort.current = controller;
        jobPaused.current = false;
        setPhashJobStatus("running");

        const candidates = imageFilesForPhash(allFiles, userId);
        const pending = candidates.filter((file) => !phashEntries.has(file.id));
        setPhashProgress(0, pending.length);

        void runPhashJob({
            files: candidates,
            entries: new Map(phashEntries),
            signal,
            shouldPause: () => jobPaused.current,
            onProgress: (current, total) => {
                if (!signal.aborted) {
                    setPhashProgress(current, total);
                }
            },
        })
            .then((entries) => {
                // An aborted run returns partial entries; the pause handler
                // already set the status and a newer run owns the state now.
                if (signal.aborted) {
                    return;
                }
                setPhashEntries(entries);
                setPhashJobStatus("done");
            })
            .catch(() => {
                if (signal.aborted) {
                    return;
                }
                setPhashJobStatus("error");
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
                errorMessage(pruneError, "Cleanup failed"),
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
            handleSelectSection("tools");
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

    const showCompressLoader = section === "compress" && showFullPageLoader;

    const shellTitle =
        section === "hub" ? "Manage" : manageSectionTitle(section);

    if (!ready || !authenticated) {
        return (
            <PageLoader
                message={ready ? "Redirecting to sign in…" : "Restoring session…"}
            />
        );
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
                                {plural(exactGroups.length, "duplicate group")} ·{" "}
                                {plural(exactStats.count, "file")} selected · ~
                                {formatFileSize(exactStats.size)} reclaimable
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
                                        {clipCoverageOnIndexed >= 2 ?
                                            ` (CLIP ≤ ${(threshold / 100).toFixed(2)})` :
                                            ""}
                                    </FieldLabel>
                                    <Slider
                                        id="similarity-threshold"
                                        min={CLIP_SCORE_SLIDER_MIN}
                                        max={CLIP_SCORE_SLIDER_MAX}
                                        step={1}
                                        value={[threshold]}
                                        onValueChange={(value) => {
                                            const next = Array.isArray(value) ? value[0] : value;
                                            if (next !== undefined) {
                                                const clamped =
                                                    clampClipScoreThreshold(next);
                                                setThreshold(clamped);
                                                if (thresholdTimer.current) {
                                                    clearTimeout(thresholdTimer.current);
                                                }
                                                thresholdTimer.current = setTimeout(() => {
                                                    setDebouncedThreshold(clamped);
                                                }, 300);
                                            }
                                        }}
                                    />
                                </Field>
                                <p className="text-xs text-muted-foreground">
                                    Indexed {phashIndexedCount} / {phashCandidateCount}{" "}
                                    images
                                    {phashIndexedCount > 0 ?
                                        ` · CLIP ${clipCoverageOnIndexed}/${phashIndexedCount}` :
                                        ""}
                                    · {plural(similarGroups.length, "similar group")}
                                    {similarBusy && similarProgress ?
                                        ` · ${similarProgress.stepDescription}` :
                                        similarBusy ?
                                            " · matching…" :
                                            ""}
                                </p>
                                {phashIndexedCount > 0 &&
                                    clipCoverageOnIndexed < 2 ? (
                                        <p className="text-xs text-muted-foreground">
                                            Scan CLIP embeddings in Settings —
                                            Similar matches each photo to its
                                            closest CLIP neighbour, then keeps
                                            pairs within the threshold. Without
                                            CLIP it falls back to hashes only.
                                        </p>
                                    ) : null}
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
                            {selections.slice(0, shownGroupCount).map((group) => (
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
                                            `~${formatFileSize(
                                                (group.items.length - 1) *
                                                      (group.items[0]?.file.info
                                                          ?.fileSize ?? 0),
                                            )}`
                                    }
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
                                            (count) => count + dedupGroupPageSize,
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
                </div>
            ) : null}

            <ConfirmDialog
                open={confirmOpen}
                title={dedupDryRun ? "Preview cleanup" : "Move duplicates to trash?"}
                description={
                    <>
                        {dedupDryRun ?
                            "Dry run enabled — no files will be changed." :
                            null}
                        {plural(prunePlan.filesToTrash.length, "file")} will be
                        moved to trash.
                        {prunePlan.collectionsToLink.size > 0 ?
                            ` ${plural(prunePlan.collectionsToLink.size, "album link")} will be added so keepers stay visible where copies were.` :
                            ""}
                    </>
                }
                confirmLabel={dedupDryRun ? "Close preview" : "Move to trash"}
                destructive={!dedupDryRun}
                isWorking={isPruning}
                confirmDisabled={prunePlan.filesToTrash.length === 0}
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
