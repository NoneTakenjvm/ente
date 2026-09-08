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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { GalleryColumnCount } from "@/lib/app-settings";
import {
    MAX_SIMILAR_MAX_GROUP_SIZE,
    MIN_SIMILAR_MAX_GROUP_SIZE,
} from "@/lib/app-settings";
import { getEnteCore } from "@/core";
import { isLocalDevToolsVisible } from "@/lib/dev-flags";
import {
    getKitEmbeddingWebGpuSkipReason,
    runKitEmbeddingJob,
} from "@/lib/kit-embedding";
import { imageFilesForPhash } from "@/lib/similarity-job";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useLibraryStore } from "@/stores/library-store";
import { usePhashIndexStore } from "@/stores/phash-index-store";
import { useSessionStore } from "@/stores/session-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";
import type { BackgroundJobStatus } from "@/stores/ui-store";

const columnOptions: GalleryColumnCount[] = [2, 3, 4, 5, 6];

const similarMaxGroupSizeOptions: number[] = Array.from(
    { length: MAX_SIMILAR_MAX_GROUP_SIZE - MIN_SIMILAR_MAX_GROUP_SIZE + 1 },
    (_, i) => MIN_SIMILAR_MAX_GROUP_SIZE + i,
);

export function ManageSettingsPanel(): JSX.Element {
    const videoAutoPlay = useSettingsStore((s) => s.videoAutoPlay);
    const videoLoop = useSettingsStore((s) => s.videoLoop);
    const videoDefaultMuted = useSettingsStore((s) => s.videoDefaultMuted);
    const galleryColumns = useSettingsStore((s) => s.galleryColumns);
    const galleryThumbnailMode = useSettingsStore((s) => s.galleryThumbnailMode);
    const similarMaxGroupSize = useSettingsStore((s) => s.similarMaxGroupSize);
    const patchSettings = useSettingsStore((s) => s.patchSettings);
    const [corpusExporting, setCorpusExporting] = useState(false);
    const [corpusExportLabel, setCorpusExportLabel] = useState("Exporting…");
    const [forceResyncing, setForceResyncing] = useState(false);
    const [showDevTools, setShowDevTools] = useState(false);
    const [clipJobStatus, setClipJobStatus] =
        useState<BackgroundJobStatus>("idle");
    const [clipProgress, setClipProgress] = useState({ current: 0, total: 0 });
    const [clipRuntime, setClipRuntime] = useState<string>("");
    const clipAbort = useRef<AbortController | undefined>(undefined);
    const clipPaused = useRef(false);
    const clipWebGpuToastShown = useRef(false);

    const allFiles = useLibraryStore((s) => s.allFiles);
    const allFilesCount = allFiles.length;
    const collectionsCount = useLibraryStore((s) => s.collections.length);
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const forceResyncLibrary = useLibraryStore((s) => s.forceResyncLibrary);
    const userId = useSessionStore((s) => s.userID) ?? 0;
    const embeddingEntries = useEmbeddingIndexStore((s) => s.entries);
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.hydrate);
    const setEmbeddingEntries = useEmbeddingIndexStore((s) => s.setEntries);

    const clipCandidateCount = useMemo(
        () => imageFilesForPhash(allFiles, userId).length,
        [allFiles, userId],
    );
    const clipIndexedCount = embeddingEntries.size;

    useEffect(() => {
        setShowDevTools(isLocalDevToolsVisible());
    }, []);

    useEffect(() => {
        if (embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings]);

    const handleStartClipJob = (): void => {
        if (clipJobStatus === "running") {
            return;
        }
        clipAbort.current?.abort();
        clipAbort.current = new AbortController();
        clipPaused.current = false;
        clipWebGpuToastShown.current = false;
        setClipJobStatus("running");
        setClipRuntime("");
        const candidates = imageFilesForPhash(allFiles, userId);
        const pending = candidates.filter(
            (file) => !embeddingEntries.has(file.id),
        );
        setClipProgress({ current: 0, total: pending.length });
        if (pending.length === 0) {
            setClipJobStatus("done");
            toast.message("CLIP scan already complete");
            return;
        }
        void runKitEmbeddingJob({
            files: allFiles,
            userId,
            existing: new Map(embeddingEntries),
            signal: clipAbort.current.signal,
            shouldPause: () => clipPaused.current,
            onProgress: (progress) => {
                if (progress.device) {
                    const label =
                        progress.device === "webgpu" ?
                            `WebGPU×${progress.concurrency ?? "?"}` :
                            `WASM×${progress.concurrency ?? "?"}`;
                    setClipRuntime(label);
                    if (
                        progress.device === "wasm" &&
                        !clipWebGpuToastShown.current
                    ) {
                        clipWebGpuToastShown.current = true;
                        const reason = getKitEmbeddingWebGpuSkipReason();
                        if (reason) {
                            toast.message(`WebGPU unavailable — ${reason}`);
                        }
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
                setEmbeddingEntries(new Map(entries));
            },
        })
            .then((entries) => {
                setEmbeddingEntries(entries);
                if (clipAbort.current?.signal.aborted && clipPaused.current) {
                    setClipJobStatus("paused");
                    return;
                }
                setClipJobStatus("done");
                toast.success(
                    `CLIP scan complete — ${entries.size} embeddings`,
                );
            })
            .catch((error: unknown) => {
                if (clipAbort.current?.signal.aborted) {
                    setClipJobStatus(clipPaused.current ? "paused" : "idle");
                    return;
                }
                setClipJobStatus("error");
                toast.error(
                    error instanceof Error ?
                        error.message :
                        "CLIP scan failed",
                );
            });
    };

    const handlePauseClipJob = (): void => {
        clipPaused.current = true;
        clipAbort.current?.abort();
        setClipJobStatus("paused");
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
                error instanceof Error ? error.message : "Resync failed";
            toast.error(message);
        } finally {
            setForceResyncing(false);
        }
    };

    const exportKitNearnessCorpus = async (): Promise<void> => {
        if (!isLocalDevToolsVisible() || corpusExporting) {
            return;
        }
        setCorpusExporting(true);
        setCorpusExportLabel("Loading CLIP model…");
        try {
            const {
                buildAnonymisedKitNearnessCorpus,
                downloadAnonymisedKitNearnessCorpus,
            } = await import("@/lib/kit-nearness-corpus-export");
            const { extractUserTags } = await import("@/lib/tags");
            const { isTagIncludedInKitNearness } = await import(
                "@/lib/tag-types"
            );
            const phashStore = usePhashIndexStore.getState();
            if (!phashStore.isHydrated) {
                await phashStore.hydrate();
            }
            const files = useLibraryStore.getState().allFiles;
            const includeInKitNearnessByName =
                useTagStore.getState().includeInKitNearnessByName;
            const onlyFileIds = new Set(
                files
                    .filter((file) =>
                        extractUserTags(file).some((tag) =>
                            isTagIncludedInKitNearness(
                                tag,
                                includeInKitNearnessByName,
                            )))
                    .map((file) => file.id),
            );
            const embeddings = await runKitEmbeddingJob({
                files,
                userId: getEnteCore().getUserID(),
                onlyFileIds,
                existing: new Map(embeddingEntries),
                onProgress: (progress) => {
                    if (progress.phase === "model") {
                        setCorpusExportLabel("Loading CLIP model…");
                        return;
                    }
                    if (progress.total === 0) {
                        setCorpusExportLabel("Building export…");
                        return;
                    }
                    setCorpusExportLabel(
                        `Embedding ${progress.completed}/${progress.total}…`,
                    );
                },
            });
            setEmbeddingEntries(embeddings);
            setCorpusExportLabel("Building export…");
            const corpus = buildAnonymisedKitNearnessCorpus({
                files,
                phashEntries: usePhashIndexStore.getState().entries,
                kits: useTagSpeedStore.getState().presets,
                includeInKitNearnessByName,
                embeddings,
            });
            if (!corpus.photos.length) {
                toast.message(
                    "Nothing to export — enable Kit nearness on tags in Manage → Tags first",
                );
                return;
            }
            const withVectors = corpus.photos.filter(
                (photo) => photo.embedding?.length,
            ).length;
            downloadAnonymisedKitNearnessCorpus(corpus);
            toast.success(
                `Exported ${corpus.photos.length} photos (${withVectors} with CLIP), ${corpus.kits.length} kits`,
            );
        } catch (error: unknown) {
            const message =
                error instanceof Error ? error.message : "Export failed";
            toast.error(message);
        } finally {
            setCorpusExporting(false);
            setCorpusExportLabel("Exporting…");
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
                            <Select
                                value={String(galleryColumns)}
                                onValueChange={(value) => {
                                    if (!value) {
                                        return;
                                    }
                                    patchSettings({
                                        galleryColumns: Number.parseInt(
                                            value,
                                            10,
                                        ) as GalleryColumnCount,
                                    });
                                }}
                            >
                                <SelectTrigger className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {columnOptions.map((count) => (
                                        <SelectItem
                                            key={count}
                                            value={String(count)}
                                        >
                                            {count} across
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
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
                                    const raw = Array.isArray(next) ?
                                        next[0] :
                                        next;
                                    if (raw === undefined || raw === "") {
                                        return;
                                    }
                                    const parsed = Number.parseInt(raw, 10);
                                    if (!Number.isFinite(parsed)) {
                                        return;
                                    }
                                    patchSettings({
                                        similarMaxGroupSize: parsed,
                                    });
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
                        Explicit on-device scan (not automatic). Embeddings power
                        kit nearness ranking via CLIP medoids; vectors stay
                        encrypted in this browser and already-scanned photos are
                        skipped. Model: CLIP ViT-B/16. Uses WebGPU (`fp16` /
                        `q4f16` when available), else WASM (`q8`). First run
                        downloads a new model weight set (old B/32 embeddings
                        are discarded).
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                        {embeddingHydrated ?
                            `${clipIndexedCount.toLocaleString()} / ${clipCandidateCount.toLocaleString()} images embedded` :
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

            {showDevTools ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Developer</CardTitle>
                        <CardDescription>
                            Local builds only. Export an anonymised kit-nearness
                            corpus for tags with “Kit nearness” enabled (dHash +
                            CLIP embeddings + remapped tag ids — no images or
                            real tag names). First run downloads a ~150MB CLIP
                            model; keep this tab open until the JSON downloads.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={corpusExporting}
                            onClick={() => {
                                void exportKitNearnessCorpus();
                            }}
                        >
                            {corpusExporting ?
                                corpusExportLabel :
                                "Export kit-nearness corpus"}
                        </Button>
                    </CardContent>
                </Card>
            ) : null}
        </div>
    );
}
