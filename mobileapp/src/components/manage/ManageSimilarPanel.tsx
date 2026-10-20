import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import { DedupGroupReview } from "@/components/manage/DedupGroupReview";
import { Button } from "@/components/ui/button";
import { JobControls } from "@/components/manage/JobControls";
import { Field, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { SimilarScopeControls } from "@/components/manage/SimilarScopeControls";
import { useJob } from "@/hooks/use-job";
import { errorMessage, plural } from "@/lib/format";
import { eligibleImageFiles, jobPercent } from "@/lib/job-utils";
import { packEmbeddings } from "@/lib/relative-sort";
import {
    defaultSimilarityThreshold,
    similarCandidateFiles,
    similarityGroupsFromIds,
    similarityGroupToSelection,
} from "@/lib/similarity-groups";
import {
    cancelSimilarPairsInWorker,
    findSimilarPairsInWorker,
    runThumbnailAnalysisJob,
    terminatePhashWorker,
} from "@/lib/similarity-job";
import {
    CLIP_SCORE_SLIDER_MAX,
    CLIP_SCORE_SLIDER_MIN,
    clampClipScoreThreshold,
    clipDistanceToScore,
    embeddingCosineDistance,
    groupClipPairs,
    type ClipPairs,
} from "@/lib/similarity-clip";
import {
    similarScopeFiles,
    type SimilarScope,
} from "@/lib/similarity-scope";
import type { DedupGroupItem } from "@/lib/dedup-prune";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { usePhashIndexStore } from "@/stores/phash-index-store";
import { useQualityIndexStore } from "@/stores/quality-index-store";
import { useSessionStore } from "@/stores/session-store";

interface ManageSimilarPanelProps {
    showLoader: boolean;
}

type ScanProgress = {
    completed: number;
    total: number;
};

/**
 * CLIP similar-photo pairs: compare each searched photo (the whole library,
 * the latest uploads or a hand-picked set) with every CLIP vector once, then
 * pair each photo with its closest match at the slider threshold (no rescan
 * when it moves).
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
    const qualityHydrated = useQualityIndexStore((s) => s.isHydrated);
    const setQualityEntries = useQualityIndexStore((s) => s.setEntries);
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);

    const phashJob = useJob();

    const [threshold, setThreshold] = useState(
        () => clampClipScoreThreshold(defaultSimilarityThreshold),
    );
    // The slider updates live while dragging; grouping only recomputes after
    // the user pauses, not on every tick.
    const [debouncedThreshold, setDebouncedThreshold] = useState(
        () => clampClipScoreThreshold(defaultSimilarityThreshold),
    );
    const thresholdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [scanError, setScanError] = useState<string | undefined>();
    /** Every pair within the slider ceiling from the last finished scan. */
    const [pairs, setPairs] = useState<ClipPairs | undefined>();
    const [scope, setScope] = useState<SimilarScope>({ kind: "library" });
    const [pickedIds, setPickedIds] = useState<Set<number>>(new Set());
    const [similarBusy, setSimilarBusy] = useState<boolean>(false);
    const [similarProgress, setSimilarProgress] = useState<
        ScanProgress | undefined
    >(undefined);
    /** Bumped per scan and on cancel, so a superseded scan's replies are ignored. */
    const scanRun = useRef(0);

    useEffect(() => {
        return (): void => {
            if (thresholdTimer.current) {
                clearTimeout(thresholdTimer.current);
            }
            scanRun.current += 1;
            cancelSimilarPairsInWorker();
            terminatePhashWorker();
        };
    }, []);

    const candidateFiles = useMemo(
        () =>
            similarCandidateFiles(
                allFiles,
                embeddingEntries,
                collections,
                userId,
            ),
        [allFiles, embeddingEntries, collections, userId],
    );

    const scopeFiles = useMemo(
        () => similarScopeFiles(scope, candidateFiles, pickedIds),
        [scope, candidateFiles, pickedIds],
    );

    // Files deleted or archived since the scan drop out of their pairs.
    const similarGroups = useMemo(() => {
        if (!pairs) {
            return [];
        }
        const filesById = new Map(
            candidateFiles.map((file) => [file.id, file]),
        );
        return similarityGroupsFromIds(
            groupClipPairs(pairs, debouncedThreshold, (fileId) =>
                filesById.has(fileId)),
            filesById,
            collections,
            userId,
        );
    }, [pairs, candidateFiles, debouncedThreshold, collections, userId]);

    const handleFindSimilar = (): void => {
        scanRun.current += 1;
        const run = scanRun.current;
        // Searched photos come first; the worker compares each with every row.
        const searchedIds = new Set(scopeFiles.map((file) => file.id));
        const fileIds = [
            ...searchedIds,
            ...candidateFiles
                .map((file) => file.id)
                .filter((fileId) => !searchedIds.has(fileId)),
        ];
        setScanError(undefined);
        setPairs(undefined);
        setSimilarBusy(true);
        setSimilarProgress({ completed: 0, total: searchedIds.size });
        findSimilarPairsInWorker(
            fileIds,
            packEmbeddings(fileIds, embeddingEntries),
            searchedIds.size,
            (completed, total) => {
                if (scanRun.current === run) {
                    setSimilarProgress({ completed, total });
                }
            },
        )
            .then((found) => {
                if (scanRun.current === run) {
                    setPairs(found);
                }
            })
            .catch((scanFailure: unknown) => {
                if (scanRun.current === run) {
                    setScanError(
                        errorMessage(scanFailure, "Similar-photo scan failed"),
                    );
                }
            })
            .finally(() => {
                if (scanRun.current === run) {
                    setSimilarBusy(false);
                    setSimilarProgress(undefined);
                }
            });
    };

    const handleCancelFind = (): void => {
        scanRun.current += 1;
        cancelSimilarPairsInWorker();
        setSimilarBusy(false);
        setSimilarProgress(undefined);
    };

    const groups = useMemo(
        () =>
            similarGroups.map((group) =>
                similarityGroupToSelection(group, false, {
                    favoriteFileIds,
                    qualityById,
                })),
        [similarGroups, favoriteFileIds, qualityById],
    );

    const eligibleCount = useMemo(
        () => eligibleImageFiles(allFiles, userId).length,
        [allFiles, userId],
    );
    const phashIndexedCount = phashEntries.size;
    const clipCount = candidateFiles.length;

    const handleStartPhashJob = (): void => {
        phashJob.start(
            (signal, onProgress) =>
                runThumbnailAnalysisJob({
                    files: allFiles,
                    userId,
                    phashEntries: new Map(phashEntries),
                    qualityEntries: qualityById,
                    signal,
                    onProgress: (current, total) => {
                        onProgress({ current, total });
                    },
                }),
            {
                onFinish: (result) => {
                    setPhashEntries(result.phashEntries);
                    setQualityEntries(result.qualityEntries);
                },
            },
        );
    };

    const similarProgressPercent = similarProgress ?
        jobPercent(similarProgress.completed, similarProgress.total) :
        0;

    const emptyTitle =
        similarBusy ?
            "Finding similar photos…" :
            clipCount < 2 ?
                "Scan CLIP embeddings" :
                !pairs ?
                    "Ready when you are" :
                    "No similar pairs";

    const emptyDescription =
        similarBusy ?
            "Comparing CLIP embeddings." :
            clipCount < 2 ?
                "Run the CLIP scan in Settings, then tap Find similar." :
                !pairs ?
                    "Tap Find similar to compare CLIP embeddings." :
                    "No similar pairs at this threshold.";

    return (
        <DedupGroupReview
            groups={groups}
            scanError={scanError}
            showLoader={showLoader}
            emptyTitle={emptyTitle}
            emptyDescription={emptyDescription}
            groupSubtitle={(group) =>
                `${pairDistanceLabel(group.items, embeddingEntries)} · ${group.items.map((item) => item.collectionName).join(", ")}`}
        >
            {() => (
                <>
                    <JobControls
                        status={phashJob.status}
                        progress={phashJob.progress}
                        startLabel="Scan library"
                        resumeLabel="Resume scan"
                        complete={
                            phashIndexedCount >= eligibleCount &&
                            eligibleCount > 0
                        }
                        disabled={
                            !phashHydrated ||
                            !qualityHydrated ||
                            phashIndexedCount >= eligibleCount
                        }
                        size="sm"
                        variant="default"
                        onStart={handleStartPhashJob}
                        onPause={phashJob.pause}
                    >
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={handleFindSimilar}
                            disabled={similarBusy || clipCount < 2 || scopeFiles.length === 0}
                        >
                            {pairs && !similarBusy ?
                                "Find again" :
                                "Find similar"}
                        </Button>
                        {similarBusy ? (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={handleCancelFind}
                            >
                                Cancel
                            </Button>
                        ) : null}
                    </JobControls>
                    <SimilarScopeControls
                        scope={scope}
                        onScopeChange={setScope}
                        pickedIds={pickedIds}
                        onPickedIdsChange={setPickedIds}
                        candidates={candidateFiles}
                        scopeSize={scopeFiles.length}
                        disabled={similarBusy}
                    />
                    <Field>
                        <FieldLabel htmlFor="similarity-threshold">
                            Threshold: CLIP ≤ {(threshold / 100).toFixed(2)}
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
                        CLIP {clipCount} / {eligibleCount} images · quality{" "}
                        {phashIndexedCount} / {eligibleCount} ·{" "}
                        {plural(similarGroups.length, "similar pair")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        Similar pairs each photo with its closest CLIP match.
                        Scan library scores quality so the best copy is kept.
                    </p>
                    {similarBusy && similarProgress ? (
                        <div className="flex flex-col gap-1">
                            <Progress
                                value={similarProgressPercent}
                                className="h-1"
                            />
                            <span className="text-xs text-muted-foreground">
                                Comparing photos {similarProgress.completed} /{" "}
                                {similarProgress.total}
                            </span>
                        </div>
                    ) : null}
                </>
            )}
        </DedupGroupReview>
    );
}

/** The pair's CLIP distance on the slider's scale, e.g. "CLIP 0.07". */
const pairDistanceLabel = (
    items: readonly DedupGroupItem[],
    embeddings: ReadonlyMap<number, ArrayLike<number>>,
): string => {
    const [first, second] = items;
    const score = clipDistanceToScore(
        embeddingCosineDistance(
            embeddings.get(first!.file.id),
            embeddings.get(second!.file.id),
        ),
    );
    return `CLIP ${(score / 100).toFixed(2)}`;
};
