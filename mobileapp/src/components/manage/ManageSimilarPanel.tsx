import {
    startTransition,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import { DedupGroupReview } from "@/components/manage/DedupGroupReview";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { errorMessage, plural } from "@/lib/format";
import { eligibleImageFiles } from "@/lib/job-utils";
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
    runPhashJob,
    runStage1InWorker,
    terminatePhashWorker,
} from "@/lib/similarity-job";
import {
    CLIP_SCORE_COLLECT_MAX,
    CLIP_SCORE_SLIDER_MAX,
    CLIP_SCORE_SLIDER_MIN,
    clampClipScoreThreshold,
} from "@/lib/similarity-clip";
import {
    EDGE_COLLECT_THRESHOLD,
    clusterFromFileEdges,
    type Stage1Cluster,
} from "@/lib/similarity-stage1-core";
import {
    clearSimilarityMatchCache,
    getCachedStage1Edges,
    setCachedStage1Edges,
    similarityIndexKey,
} from "@/lib/similarity-match-cache";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { usePhashIndexStore } from "@/stores/phash-index-store";
import { useQualityIndexStore } from "@/stores/quality-index-store";
import { useSessionStore } from "@/stores/session-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePhashJobStore } from "@/stores/ui-store";

interface ManageSimilarPanelProps {
    showLoader: boolean;
}

/**
 * Hash/CLIP similar-photo groups: library hash scan, find, and cleanup.
 */
export function ManageSimilarPanel({
    showLoader,
}: ManageSimilarPanelProps): JSX.Element {
    const userId = useSessionStore((s) => s.userID) ?? 0;
    const allFiles = useLibraryStore((s) => s.allFiles);
    const collections = useLibraryStore((s) => s.collections);

    const phashEntries = usePhashIndexStore((s) => s.entries);
    const phashHydrated = usePhashIndexStore((s) => s.isHydrated);
    const setPhashEntries = usePhashIndexStore((s) => s.setEntries);
    const embeddingEntries = useEmbeddingIndexStore((s) => s.entries);
    const qualityById = useQualityIndexStore((s) => s.entries);
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);

    const phashJobStatus = usePhashJobStore((s) => s.status);
    const phashProgress = usePhashJobStore((s) => s.progress);
    const setPhashJobStatus = usePhashJobStore((s) => s.setStatus);
    const setPhashProgress = usePhashJobStore((s) => s.setProgress);

    const similarMaxGroupSize = useSettingsStore((s) => s.similarMaxGroupSize);
    const similarMaxGroupSizeRef = useRef(similarMaxGroupSize);

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
    const [scanError, setScanError] = useState<string | undefined>();
    const [similarGroups, setSimilarGroups] = useState<SimilarityGroup[]>([]);
    const [similarBusy, setSimilarBusy] = useState<boolean>(false);
    const [similarProgress, setSimilarProgress] = useState<
        SimilarMatchProgress | undefined
    >(undefined);
    /** >0 means the user asked to find similar groups; 0 = idle until they tap Find. */
    const [similarFindGeneration, setSimilarFindGeneration] = useState<number>(0);

    const jobAbort = useRef<AbortController | undefined>(undefined);
    const jobPaused = useRef<boolean>(false);
    const cropMergeAbort = useRef<AbortController | undefined>(undefined);
    /** Uncapped groups from the last similar find (trim for display / max-size). */
    const lastFullSimilarGroups = useRef<SimilarityGroup[]>([]);

    useEffect(() => {
        similarMaxGroupSizeRef.current = similarMaxGroupSize;
    }, [similarMaxGroupSize]);

    useEffect(() => {
        return (): void => {
            if (thresholdTimer.current) {
                clearTimeout(thresholdTimer.current);
            }
            jobAbort.current?.abort();
            // The aborted run no longer updates the store, so don't leave it "running".
            if (usePhashJobStore.getState().status === "running") {
                usePhashJobStore.getState().setStatus("paused");
            }
            cropMergeAbort.current?.abort();
            // Drop session edge/crop caches when leaving Similar — they can
            // pin tens of thousands of verdicts and freeze/OOM the phone.
            clearSimilarityMatchCache();
            terminatePhashWorker();
        };
    }, []);

    // Stage-1 then async crop merge — only after the user taps Find similar.
    // Edge + crop verdict caches make later threshold changes cheap.
    useEffect(() => {
        cropMergeAbort.current?.abort();
        cropMergeAbort.current = undefined;

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
                setScanError(
                    errorMessage(runError, "Similar-photo scan failed"),
                );
            }
        });

        return (): void => {
            cancelled = true;
            abort.abort();
        };
    }, [
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
        if (similarFindGeneration === 0) {
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
    }, [similarFindGeneration, similarMaxGroupSize]);

    const groups = useMemo(
        () =>
            similarGroups.map((group) =>
                similarityGroupToSelection(group, false, {
                    favoriteFileIds,
                    qualityById,
                })),
        [similarGroups, favoriteFileIds, qualityById],
    );

    const phashCandidateCount = useMemo(
        () => eligibleImageFiles(allFiles, userId).length,
        [allFiles, userId],
    );
    const phashIndexedCount = phashEntries.size;
    const clipCoverageOnIndexed = useMemo(() => {
        if (phashEntries.size === 0) {
            return 0;
        }
        let n = 0;
        for (const id of phashEntries.keys()) {
            if (embeddingEntries.has(id)) {
                n += 1;
            }
        }
        return n;
    }, [phashEntries, embeddingEntries]);

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

        const candidates = eligibleImageFiles(allFiles, userId);
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

    const emptyTitle =
        similarBusy ?
            "Finding similar photos…" :
            phashIndexedCount < 2 ?
                "Scan your library" :
                similarFindGeneration === 0 ?
                    "Ready when you are" :
                    "No similar groups";

    const emptyDescription =
        similarBusy ?
            "Comparing photos — groups appear as matches are found." :
            similarFindGeneration === 0 ?
                phashIndexedCount < 2 ?
                    "Scan your library to hash photos, then tap Find similar." :
                    "Hash new photos with Scan library if needed, then tap Find similar." :
                phashIndexedCount < 2 ?
                    "Scan your library to find similar photos." :
                    "No similar groups at this threshold.";

    return (
        <DedupGroupReview
            groups={groups}
            scanError={scanError}
            showLoader={showLoader}
            emptyTitle={emptyTitle}
            emptyDescription={emptyDescription}
            groupSubtitle={(group) =>
                group.items.map((item) => item.collectionName).join(", ")}
        >
            {() => (
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
                    {phashIndexedCount > 0 && clipCoverageOnIndexed < 2 ? (
                        <p className="text-xs text-muted-foreground">
                            Scan CLIP embeddings in Settings — Similar matches
                            each photo to its closest CLIP neighbour, then keeps
                            pairs within the threshold. Without CLIP it falls
                            back to hashes only.
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
        </DedupGroupReview>
    );
}
