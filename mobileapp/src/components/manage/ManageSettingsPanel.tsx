import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    CLIP_EMBEDDING_BATCH_SIZE_AUTO,
    CLIP_EMBEDDING_BATCH_SIZE_OPTIONS,
    clampClipEmbeddingBatchSize,
    clampGalleryColumns,
    MAX_GALLERY_COLUMNS,
    MAX_SIMILAR_MAX_GROUP_SIZE,
    MIN_GALLERY_COLUMNS,
    MIN_SIMILAR_MAX_GROUP_SIZE,
} from "@/lib/app-settings";
import {
    getKitEmbeddingBatchFallbackReason,
    getKitEmbeddingWebGpuSkipReason,
    KIT_EMBEDDING_MODEL_ID,
    runKitEmbeddingJob,
    stripVideoEmbeddings,
} from "@/lib/kit-embedding";
import { eligibleImageFiles } from "@/lib/job-utils";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useLibraryStore } from "@/stores/library-store";
import { useQualityIndexStore } from "@/stores/quality-index-store";
import { useSessionStore } from "@/stores/session-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { BackgroundJobStatus } from "@/stores/ui-store";
import {
    filesNeedingAnalysis,
    runThumbnailAnalysisJob,
} from "@/lib/similarity-job";
import { usePhashIndexStore } from "@/stores/phash-index-store";
import { errorMessage } from "@/lib/format";

const columnOptions: number[] = Array.from(
    { length: MAX_GALLERY_COLUMNS - MIN_GALLERY_COLUMNS + 1 },
    (_, i) => MIN_GALLERY_COLUMNS + i,
);

const similarMaxGroupSizeOptions: number[] = Array.from(
    { length: MAX_SIMILAR_MAX_GROUP_SIZE - MIN_SIMILAR_MAX_GROUP_SIZE + 1 },
    (_, i) => MIN_SIMILAR_MAX_GROUP_SIZE + i,
);

const clipBatchSizeOptions: number[] = [
    CLIP_EMBEDDING_BATCH_SIZE_AUTO,
    ...CLIP_EMBEDDING_BATCH_SIZE_OPTIONS,
];

/** First selected toggle value as an integer, or `undefined` when none/invalid. */
const parseToggleInteger = (next: unknown): number | undefined => {
    const raw: unknown = Array.isArray(next) ? next[0] : next;
    if (typeof raw !== "string" || raw === "") {
        return undefined;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
};

export function ManageSettingsPanel(): JSX.Element {
    const videoAutoPlay = useSettingsStore((s) => s.videoAutoPlay);
    const videoLoop = useSettingsStore((s) => s.videoLoop);
    const videoDefaultMuted = useSettingsStore((s) => s.videoDefaultMuted);
    const galleryColumns = useSettingsStore((s) => s.galleryColumns);
    const galleryThumbnailMode = useSettingsStore((s) => s.galleryThumbnailMode);
    const similarMaxGroupSize = useSettingsStore((s) => s.similarMaxGroupSize);
    const clipEmbeddingBatchSize = useSettingsStore(
        (s) => s.clipEmbeddingBatchSize,
    );
    const patchSettings = useSettingsStore((s) => s.patchSettings);
    const [forceResyncing, setForceResyncing] = useState(false);
    const [clipJobStatus, setClipJobStatus] =
        useState<BackgroundJobStatus>("idle");
    const [clipProgress, setClipProgress] = useState({ current: 0, total: 0 });
    const [clipRuntime, setClipRuntime] = useState<string>("");
    const clipAbort = useRef<AbortController | undefined>(undefined);
    const clipPaused = useRef(false);
    const clipSmokeToastShown = useRef(false);
    const clipBatchFallbackToastShown = useRef(false);
    const [qualityJobStatus, setQualityJobStatus] =
        useState<BackgroundJobStatus>("idle");
    const [qualityProgress, setQualityProgress] = useState({
        current: 0,
        total: 0,
    });
    const qualityAbort = useRef<AbortController | undefined>(undefined);
    const qualityPaused = useRef(false);

    const allFiles = useLibraryStore((s) => s.allFiles);
    const allFilesCount = allFiles.length;
    const collectionsCount = useLibraryStore((s) => s.collections.length);
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const forceResyncLibrary = useLibraryStore((s) => s.forceResyncLibrary);
    const userId = useSessionStore((s) => s.userID) ?? 0;
    const embeddingEntries = useEmbeddingIndexStore((s) => s.entries);
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.ensureHydrated);
    const setEmbeddingEntries = useEmbeddingIndexStore((s) => s.setEntries);
    const qualityEntries = useQualityIndexStore((s) => s.entries);
    const qualityHydrated = useQualityIndexStore((s) => s.isHydrated);
    const hydrateQuality = useQualityIndexStore((s) => s.ensureHydrated);
    const setQualityEntries = useQualityIndexStore((s) => s.setEntries);
    const phashEntries = usePhashIndexStore((s) => s.entries);
    const phashHydrated = usePhashIndexStore((s) => s.isHydrated);
    const hydratePhash = usePhashIndexStore((s) => s.ensureHydrated);
    const setPhashEntries = usePhashIndexStore((s) => s.setEntries);

    const clipCandidateCount = useMemo(
        () => eligibleImageFiles(allFiles, userId).length,
        [allFiles, userId],
    );
    const clipIndexedCount = embeddingEntries.size;
    const qualityCandidateCount = clipCandidateCount;
    const qualityIndexedCount = qualityEntries.size;

    // Job status is local state, so a job left running would be invisible on
    // return and a second one could start alongside it.
    useEffect(() => {
        return (): void => {
            clipPaused.current = true;
            qualityPaused.current = true;
            clipAbort.current?.abort();
            qualityAbort.current?.abort();
        };
    }, []);

    useEffect(() => {
        if (embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings]);

    useEffect(() => {
        if (qualityHydrated) {
            return;
        }
        void hydrateQuality();
    }, [qualityHydrated, hydrateQuality]);

    useEffect(() => {
        if (phashHydrated) {
            return;
        }
        void hydratePhash();
    }, [phashHydrated, hydratePhash]);

    // Drop any stale video poster vectors once the library is known. Keyed on
    // the library, not every embeddings write, so each CLIP batch skips the scan.
    useEffect(() => {
        if (!embeddingHydrated || allFiles.length === 0) {
            return;
        }
        const entries = useEmbeddingIndexStore.getState().entries;
        const pruned = stripVideoEmbeddings(entries, allFiles);
        if (pruned !== entries) {
            setEmbeddingEntries(pruned);
        }
    }, [allFiles, embeddingHydrated, setEmbeddingEntries]);

    const handleStartClipJob = (): void => {
        if (clipJobStatus === "running") {
            return;
        }
        clipAbort.current?.abort();
        const controller = new AbortController();
        const { signal } = controller;
        clipAbort.current = controller;
        clipPaused.current = false;
        clipSmokeToastShown.current = false;
        clipBatchFallbackToastShown.current = false;
        setClipJobStatus("running");
        setClipRuntime("");
        const candidates = eligibleImageFiles(allFiles, userId);
        const existing = stripVideoEmbeddings(embeddingEntries, allFiles);
        if (existing !== embeddingEntries) {
            setEmbeddingEntries(existing);
        }
        const pending = candidates.filter((file) => !existing.has(file.id));
        setClipProgress({ current: 0, total: pending.length });
        if (pending.length === 0) {
            setClipJobStatus("done");
            toast.message("CLIP scan already complete");
            return;
        }
        void runKitEmbeddingJob({
            files: allFiles,
            userId,
            existing,
            signal,
            shouldPause: () => clipPaused.current,
            onProgress: (progress) => {
                if (signal.aborted) {
                    return;
                }
                if (progress.device) {
                    const mode =
                        progress.batchMode === "sequential" ?
                            "sequential" :
                            `batch×${progress.batchSize ?? "?"}`;
                    const dtype = progress.dtype ?? "?";
                    const label = `${progress.device === "webgpu" ? "WebGPU" : "WASM"} ${dtype} · ${mode}`;
                    setClipRuntime(label);
                    if (!clipSmokeToastShown.current) {
                        clipSmokeToastShown.current = true;
                        if (progress.device === "webgpu") {
                            toast.success(
                                `MobileCLIP-S2 on WebGPU (${dtype})`,
                            );
                        } else {
                            const reason = getKitEmbeddingWebGpuSkipReason();
                            toast.message(
                                reason ?
                                    `MobileCLIP-S2 on WASM — ${reason}` :
                                    "MobileCLIP-S2 on WASM",
                            );
                        }
                    }
                    if (
                        progress.batchMode === "sequential" &&
                        (progress.batchSize ?? 1) > 1 &&
                        !clipBatchFallbackToastShown.current
                    ) {
                        clipBatchFallbackToastShown.current = true;
                        const reason = getKitEmbeddingBatchFallbackReason();
                        toast.message(
                            reason ?
                                `S2 batch failed — sequential (${reason})` :
                                "S2 batch failed — running sequential",
                        );
                    }
                }
                if (progress.phase === "embed") {
                    setClipProgress({
                        current: progress.completed,
                        total: progress.total,
                    });
                }
            },
            onBatchPersisted: (entries) => {
                if (!signal.aborted) {
                    setEmbeddingEntries(new Map(entries));
                }
            },
        })
            .then((entries) => {
                // A superseded run must not overwrite the newer run's state.
                if (clipAbort.current !== controller) {
                    return;
                }
                setEmbeddingEntries(entries);
                if (signal.aborted) {
                    setClipJobStatus("paused");
                    return;
                }
                setClipJobStatus("done");
                toast.success(
                    `CLIP scan complete — ${entries.size} embeddings`,
                );
            })
            .catch((error: unknown) => {
                if (clipAbort.current !== controller) {
                    return;
                }
                if (signal.aborted) {
                    setClipJobStatus("paused");
                    return;
                }
                setClipJobStatus("error");
                toast.error(
                    errorMessage(error, "CLIP scan failed"),
                );
            });
    };

    const handlePauseClipJob = (): void => {
        clipPaused.current = true;
        clipAbort.current?.abort();
        setClipJobStatus("paused");
    };

    const handleStartQualityJob = (): void => {
        if (qualityJobStatus === "running") {
            return;
        }
        qualityAbort.current?.abort();
        const controller = new AbortController();
        const { signal } = controller;
        qualityAbort.current = controller;
        qualityPaused.current = false;
        setQualityJobStatus("running");
        // The scan also hashes the same thumbnails for Similar photos.
        const pending = filesNeedingAnalysis(
            allFiles,
            userId,
            phashEntries,
            qualityEntries,
        );
        setQualityProgress({ current: 0, total: pending.length });
        if (pending.length === 0) {
            setQualityJobStatus("done");
            toast.message("Image quality scan already complete");
            return;
        }
        void runThumbnailAnalysisJob({
            files: allFiles,
            userId,
            phashEntries: new Map(phashEntries),
            qualityEntries,
            signal,
            shouldPause: () => qualityPaused.current,
            onProgress: (current, total) => {
                if (!signal.aborted) {
                    setQualityProgress({ current, total });
                }
            },
        })
            .then((result) => {
                if (qualityAbort.current !== controller) {
                    return;
                }
                setQualityEntries(result.qualityEntries);
                setPhashEntries(result.phashEntries);
                if (signal.aborted) {
                    setQualityJobStatus("paused");
                    return;
                }
                setQualityJobStatus("done");
                toast.success(
                    `Image quality scan complete — ${result.qualityEntries.size} scored`,
                );
            })
            .catch((error: unknown) => {
                if (qualityAbort.current !== controller) {
                    return;
                }
                if (signal.aborted) {
                    setQualityJobStatus("paused");
                    return;
                }
                setQualityJobStatus("error");
                toast.error(
                    errorMessage(error, "Image quality scan failed"),
                );
            });
    };

    const handlePauseQualityJob = (): void => {
        qualityPaused.current = true;
        qualityAbort.current?.abort();
        setQualityJobStatus("paused");
    };

    const runForceResync = async (): Promise<void> => {
        if (forceResyncing || syncStatus === "syncing") {
            return;
        }
        setForceResyncing(true);
        try {
            await forceResyncLibrary();
            const count = useLibraryStore.getState().allFiles.length;
            toast.success(`Library resynced — ${count} files loaded`);
        } catch (error: unknown) {
            const message =
                errorMessage(error, "Resync failed");
            toast.error(message);
        } finally {
            setForceResyncing(false);
        }
    };

    return (
        <div className="flex flex-col gap-4 px-4 py-4">
            <Card>
                <CardHeader>
                    <CardTitle>Library</CardTitle>
                    <CardDescription>
                        Local copy of owned albums. If the count looks low after
                        a failed or partial sync, force a full re-pull.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                        {allFilesCount.toLocaleString()} files ·{" "}
                        {collectionsCount.toLocaleString()} albums
                        {syncStatus === "syncing" ? " · syncing…" : ""}
                    </p>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={forceResyncing || syncStatus === "syncing"}
                        onClick={() => {
                            void runForceResync();
                        }}
                    >
                        {forceResyncing || syncStatus === "syncing" ?
                            "Resyncing…" :
                            "Force full resync"}
                    </Button>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Video</CardTitle>
                    <CardDescription>
                        Playback behavior in the photo viewer.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <FieldGroup>
                        <Field orientation="horizontal">
                            <FieldLabel htmlFor="video-auto-play">
                                Auto play
                            </FieldLabel>
                            <Switch
                                id="video-auto-play"
                                checked={videoAutoPlay}
                                onCheckedChange={(checked) => {
                                    patchSettings({ videoAutoPlay: checked });
                                }}
                            />
                        </Field>
                        <Field orientation="horizontal">
                            <FieldLabel htmlFor="video-loop">Loop</FieldLabel>
                            <Switch
                                id="video-loop"
                                checked={videoLoop}
                                onCheckedChange={(checked) => {
                                    patchSettings({ videoLoop: checked });
                                }}
                            />
                        </Field>
                        <Field orientation="horizontal">
                            <FieldLabel htmlFor="video-default-muted">
                                Start muted
                            </FieldLabel>
                            <Switch
                                id="video-default-muted"
                                checked={videoDefaultMuted}
                                onCheckedChange={(checked) => {
                                    patchSettings({ videoDefaultMuted: checked });
                                }}
                            />
                        </Field>
                    </FieldGroup>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Gallery</CardTitle>
                    <CardDescription>
                        How photos and videos appear in grid views.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <FieldGroup>
                        <Field>
                            <FieldLabel>Gallery width</FieldLabel>
                            <ToggleGroup
                                variant="outline"
                                value={[String(galleryColumns)]}
                                onValueChange={(next) => {
                                    const parsed = parseToggleInteger(next);
                                    if (parsed !== undefined) {
                                        patchSettings({
                                            galleryColumns:
                                                clampGalleryColumns(parsed),
                                        });
                                    }
                                }}
                                className="w-full"
                            >
                                {columnOptions.map((count) => (
                                    <ToggleGroupItem
                                        key={count}
                                        value={String(count)}
                                        className="flex-1"
                                    >
                                        {count}
                                    </ToggleGroupItem>
                                ))}
                            </ToggleGroup>
                        </Field>
                        <Field>
                            <FieldLabel>Thumbnail layout</FieldLabel>
                            <ToggleGroup
                                variant="outline"
                                value={[galleryThumbnailMode]}
                                onValueChange={(next) => {
                                    const value = Array.isArray(next) ?
                                        next[0] :
                                        next;
                                    if (
                                        value === "grid" ||
                                        value === "fit"
                                    ) {
                                        patchSettings({
                                            galleryThumbnailMode: value,
                                        });
                                    }
                                }}
                                className="w-full"
                            >
                                <ToggleGroupItem
                                    value="grid"
                                    className="flex-1"
                                >
                                    Grid
                                </ToggleGroupItem>
                                <ToggleGroupItem
                                    value="fit"
                                    className="flex-1"
                                >
                                    Fit
                                </ToggleGroupItem>
                            </ToggleGroup>
                        </Field>
                    </FieldGroup>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Similar photos</CardTitle>
                    <CardDescription>
                        Matching finds natural similar piles with no size cap.
                        Groups larger than this setting are hidden (not split
                        into smaller cards).
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <FieldGroup>
                        <Field>
                            <FieldLabel>Max group size</FieldLabel>
                            <ToggleGroup
                                variant="outline"
                                value={[String(similarMaxGroupSize)]}
                                onValueChange={(next) => {
                                    const parsed = parseToggleInteger(next);
                                    if (parsed !== undefined) {
                                        patchSettings({
                                            similarMaxGroupSize: parsed,
                                        });
                                    }
                                }}
                                className="w-full"
                            >
                                {similarMaxGroupSizeOptions.map((size) => (
                                    <ToggleGroupItem
                                        key={size}
                                        value={String(size)}
                                        className="flex-1"
                                    >
                                        {size}
                                    </ToggleGroupItem>
                                ))}
                            </ToggleGroup>
                            <p className="text-xs text-muted-foreground">
                                Hide piles larger than this (usually false
                                positives)
                            </p>
                        </Field>
                    </FieldGroup>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Kit nearness (CLIP)</CardTitle>
                    <CardDescription>
                        Smoke test: MobileCLIP-S2 (`{KIT_EMBEDDING_MODEL_ID}`).
                        Changing model drops the old ViT-B/16 index — rescan
                        required. Loads WASM fp32 first, then upgrades to
                        WebGPU fp32 if the FastViT graph runs. Status line shows the backend that actually
                        loaded; “sequential” means a batched GPU forward failed
                        and images run one at a time (still a valid smoke).
                        Videos are never scanned.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    <FieldGroup>
                        <Field>
                            <FieldLabel>ORT batch size</FieldLabel>
                            <ToggleGroup
                                variant="outline"
                                value={[String(clipEmbeddingBatchSize)]}
                                onValueChange={(next) => {
                                    const parsed = parseToggleInteger(next);
                                    if (parsed !== undefined) {
                                        patchSettings({
                                            clipEmbeddingBatchSize:
                                                clampClipEmbeddingBatchSize(
                                                    parsed,
                                                ),
                                        });
                                    }
                                }}
                                className="w-full flex-wrap"
                            >
                                {clipBatchSizeOptions.map((count) => (
                                    <ToggleGroupItem
                                        key={count}
                                        value={String(count)}
                                        className="flex-1 min-w-8"
                                    >
                                        {count ===
                                        CLIP_EMBEDDING_BATCH_SIZE_AUTO ?
                                            "Auto" :
                                            count}
                                    </ToggleGroupItem>
                                ))}
                            </ToggleGroup>
                        </Field>
                    </FieldGroup>
                    <p className="text-sm text-muted-foreground">
                        {embeddingHydrated ?
                            `${(
                                clipJobStatus === "running" ?
                                    clipIndexedCount + clipProgress.current :
                                    clipIndexedCount
                            ).toLocaleString()} / ${clipCandidateCount.toLocaleString()} images embedded` :
                            "Loading embedding index…"}
                        {clipRuntime ? ` · ${clipRuntime}` : null}
                        {clipJobStatus === "running" && clipProgress.total > 0 ?
                            ` · scanning ${clipProgress.current}/${clipProgress.total}` :
                            null}
                        {clipJobStatus === "paused" ?
                            " · paused" :
                            null}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={
                                clipJobStatus === "running" ||
                                !embeddingHydrated ||
                                (clipIndexedCount >= clipCandidateCount &&
                                    clipCandidateCount > 0)
                            }
                            onClick={handleStartClipJob}
                        >
                            {clipIndexedCount >= clipCandidateCount &&
                            clipCandidateCount > 0 ?
                                "Scan complete" :
                                clipJobStatus === "paused" ?
                                    "Resume CLIP scan" :
                                    "Scan CLIP embeddings"}
                        </Button>
                        {clipJobStatus === "running" ? (
                            <Button
                                type="button"
                                variant="outline"
                                onClick={handlePauseClipJob}
                            >
                                Pause
                            </Button>
                        ) : null}
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Image quality</CardTitle>
                    <CardDescription>
                        Score stills for grain, pixelation, blur, and low
                        resolution from thumbnails. Used by Options → Sort →
                        Image quality. After an app update that changes the
                        formula, run the scan again (old scores are discarded).
                        The same pass also hashes photos for Similar. Videos
                        are never scanned.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                        {qualityHydrated ?
                            `${qualityIndexedCount.toLocaleString()} / ${qualityCandidateCount.toLocaleString()} images scored` :
                            "Loading quality index…"}
                        {qualityJobStatus === "running" &&
                        qualityProgress.total > 0 ?
                            ` · scanning ${qualityProgress.current}/${qualityProgress.total}` :
                            null}
                        {qualityJobStatus === "paused" ? " · paused" : null}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={
                                qualityJobStatus === "running" ||
                                !qualityHydrated ||
                                !phashHydrated ||
                                (qualityIndexedCount >= qualityCandidateCount &&
                                    qualityCandidateCount > 0)
                            }
                            onClick={handleStartQualityJob}
                        >
                            {qualityIndexedCount >= qualityCandidateCount &&
                            qualityCandidateCount > 0 ?
                                "Scan complete" :
                                qualityJobStatus === "paused" ?
                                    "Resume quality scan" :
                                    "Scan image quality"}
                        </Button>
                        {qualityJobStatus === "running" ? (
                            <Button
                                type="button"
                                variant="outline"
                                onClick={handlePauseQualityJob}
                            >
                                Pause
                            </Button>
                        ) : null}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
