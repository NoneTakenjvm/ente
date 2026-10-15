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
import { JobControls } from "@/components/manage/JobControls";
import { useJob } from "@/hooks/use-job";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    CLIP_EMBEDDING_BATCH_SIZE_AUTO,
    CLIP_EMBEDDING_BATCH_SIZE_OPTIONS,
    clampClipEmbeddingBatchSize,
    clampGalleryColumns,
    MAX_GALLERY_COLUMNS,
    MIN_GALLERY_COLUMNS,
    SLIDESHOW_SECONDS_OPTIONS,
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

const slideshowSecondsOptions: number[] = [...SLIDESHOW_SECONDS_OPTIONS];

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

const videoSwitches = [
    { key: "videoAutoPlay", label: "Auto play" },
    { key: "videoLoop", label: "Loop" },
    { key: "videoDefaultMuted", label: "Start muted" },
] as const;

export function ManageSettingsPanel(): JSX.Element {
    const videoAutoPlay = useSettingsStore((s) => s.videoAutoPlay);
    const videoLoop = useSettingsStore((s) => s.videoLoop);
    const videoDefaultMuted = useSettingsStore((s) => s.videoDefaultMuted);
    const videoSettings = { videoAutoPlay, videoLoop, videoDefaultMuted };
    const galleryColumns = useSettingsStore((s) => s.galleryColumns);
    const galleryThumbnailMode = useSettingsStore((s) => s.galleryThumbnailMode);
    const slideshowSeconds = useSettingsStore((s) => s.slideshowSeconds);
    const clipEmbeddingBatchSize = useSettingsStore(
        (s) => s.clipEmbeddingBatchSize,
    );
    const patchSettings = useSettingsStore((s) => s.patchSettings);
    const [forceResyncing, setForceResyncing] = useState(false);
    const clipJob = useJob();
    const [clipRuntime, setClipRuntime] = useState<string>("");
    const clipSmokeToastShown = useRef(false);
    const clipBatchFallbackToastShown = useRef(false);
    const qualityJob = useJob();

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
        clipSmokeToastShown.current = false;
        clipBatchFallbackToastShown.current = false;
        setClipRuntime("");
        const existing = stripVideoEmbeddings(embeddingEntries, allFiles);
        if (existing !== embeddingEntries) {
            setEmbeddingEntries(existing);
        }
        const candidates = eligibleImageFiles(allFiles, userId);
        if (candidates.every((file) => existing.has(file.id))) {
            toast.message("CLIP scan already complete");
            return;
        }
        clipJob.start(
            (signal, onProgress) =>
                runKitEmbeddingJob({
                    files: allFiles,
                    userId,
                    existing,
                    signal,
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
                            onProgress({
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
                }),
            {
                onFinish: (entries, aborted) => {
                    setEmbeddingEntries(entries);
                    if (!aborted) {
                        toast.success(
                            `CLIP scan complete — ${entries.size} embeddings`,
                        );
                    }
                },
                onError: (error) => {
                    toast.error(errorMessage(error, "CLIP scan failed"));
                },
            },
        );
    };

    const handleStartQualityJob = (): void => {
        // The scan also hashes the same thumbnails for Similar photos.
        const pending = filesNeedingAnalysis(
            allFiles,
            userId,
            phashEntries,
            qualityEntries,
        );
        if (pending.length === 0) {
            toast.message("Image quality scan already complete");
            return;
        }
        qualityJob.start(
            (signal, onProgress) =>
                runThumbnailAnalysisJob({
                    files: allFiles,
                    userId,
                    phashEntries: new Map(phashEntries),
                    qualityEntries,
                    signal,
                    onProgress: (current, total) => {
                        onProgress({ current, total });
                    },
                }),
            {
                onFinish: (result, aborted) => {
                    setQualityEntries(result.qualityEntries);
                    setPhashEntries(result.phashEntries);
                    if (!aborted) {
                        toast.success(
                            `Image quality scan complete — ${result.qualityEntries.size} scored`,
                        );
                    }
                },
                onError: (error) => {
                    toast.error(
                        errorMessage(error, "Image quality scan failed"),
                    );
                },
            },
        );
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
                        {videoSwitches.map(({ key, label }) => (
                            <Field key={key} orientation="horizontal">
                                <FieldLabel htmlFor={key}>
                                    {label}
                                </FieldLabel>
                                <Switch
                                    id={key}
                                    checked={videoSettings[key]}
                                    onCheckedChange={(checked) => {
                                        patchSettings({ [key]: checked });
                                    }}
                                />
                            </Field>
                        ))}
                    </FieldGroup>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Slideshow</CardTitle>
                    <CardDescription>
                        Start it with the play button in the photo viewer.
                        Videos play to the end; zooming in pauses the timer.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <FieldGroup>
                        <NumberToggleField
                            label="Seconds per photo"
                            value={slideshowSeconds}
                            options={slideshowSecondsOptions}
                            optionLabel={(seconds) => `${seconds}s`}
                            onChange={(seconds) => {
                                patchSettings({ slideshowSeconds: seconds });
                            }}
                        />
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
                        <NumberToggleField
                            label="Gallery width"
                            value={galleryColumns}
                            options={columnOptions}
                            onChange={(columns) => {
                                patchSettings({
                                    galleryColumns: clampGalleryColumns(columns),
                                });
                            }}
                        />
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
                        <NumberToggleField
                            label="ORT batch size"
                            value={clipEmbeddingBatchSize}
                            options={clipBatchSizeOptions}
                            className="w-full flex-wrap"
                            itemClassName="flex-1 min-w-8"
                            optionLabel={(count) =>
                                count === CLIP_EMBEDDING_BATCH_SIZE_AUTO ?
                                    "Auto" :
                                    String(count)}
                            onChange={(count) => {
                                patchSettings({
                                    clipEmbeddingBatchSize:
                                        clampClipEmbeddingBatchSize(count),
                                });
                            }}
                        />
                    </FieldGroup>
                    <p className="text-sm text-muted-foreground">
                        {embeddingHydrated ?
                            `${(
                                clipJob.status === "running" ?
                                    clipIndexedCount +
                                    (clipJob.progress?.current ?? 0) :
                                    clipIndexedCount
                            ).toLocaleString()} / ${clipCandidateCount.toLocaleString()} images embedded` :
                            "Loading embedding index…"}
                        {clipRuntime ? ` · ${clipRuntime}` : null}
                    </p>
                    <JobControls
                        status={clipJob.status}
                        progress={clipJob.progress}
                        startLabel="Scan CLIP embeddings"
                        resumeLabel="Resume CLIP scan"
                        complete={
                            clipIndexedCount >= clipCandidateCount &&
                            clipCandidateCount > 0
                        }
                        disabled={!embeddingHydrated}
                        onStart={handleStartClipJob}
                        onPause={clipJob.pause}
                    />
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
                    </p>
                    <JobControls
                        status={qualityJob.status}
                        progress={qualityJob.progress}
                        startLabel="Scan image quality"
                        resumeLabel="Resume quality scan"
                        complete={
                            qualityIndexedCount >= qualityCandidateCount &&
                            qualityCandidateCount > 0
                        }
                        disabled={!qualityHydrated || !phashHydrated}
                        onStart={handleStartQualityJob}
                        onPause={qualityJob.pause}
                    />
                </CardContent>
            </Card>
        </div>
    );
}

/** Labeled toggle group over integer `options`; calls `onChange` with the tapped one. */
function NumberToggleField({
    label,
    value,
    options,
    hint,
    className = "w-full",
    itemClassName = "flex-1",
    optionLabel = String,
    onChange,
}: {
    label: string;
    value: number;
    options: number[];
    hint?: string;
    className?: string;
    itemClassName?: string;
    optionLabel?: (option: number) => string;
    onChange: (value: number) => void;
}): JSX.Element {
    return (
        <Field>
            <FieldLabel>{label}</FieldLabel>
            <ToggleGroup
                variant="outline"
                value={[String(value)]}
                onValueChange={(next) => {
                    const parsed = parseToggleInteger(next);
                    if (parsed !== undefined) {
                        onChange(parsed);
                    }
                }}
                className={className}
            >
                {options.map((option) => (
                    <ToggleGroupItem
                        key={option}
                        value={String(option)}
                        className={itemClassName}
                    >
                        {optionLabel(option)}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
            {hint ? (
                <p className="text-xs text-muted-foreground">{hint}</p>
            ) : null}
        </Field>
    );
}
