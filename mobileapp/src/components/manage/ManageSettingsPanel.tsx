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
import { getEnteCore } from "@/core";
import { isLocalDevToolsVisible } from "@/lib/dev-flags";
import {
    getKitEmbeddingBatchFallbackReason,
    getKitEmbeddingWebGpuSkipReason,
    KIT_EMBEDDING_MODEL_ID,
    runKitEmbeddingJob,
    stripVideoEmbeddings,
} from "@/lib/kit-embedding";
import type { KitTileEmbeddingCoverage } from "@/lib/kit-tile-embedding-job";
import { KIT_TILE_LAYOUT_ID } from "@/lib/kit-tile-layout";
import { isEnteVideoFile } from "@/lib/media-kind";
import { imageFilesForPhash } from "@/lib/similarity-job";
import { isTagIncludedInKitNearness } from "@/lib/tag-types";
import { extractUserTags } from "@/lib/tags";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import type { EnteFile } from "ente-media/file";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useLibraryStore } from "@/stores/library-store";
import { usePhashIndexStore } from "@/stores/phash-index-store";
import { useQualityIndexStore } from "@/stores/quality-index-store";
import { useSessionStore } from "@/stores/session-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";
import type { BackgroundJobStatus } from "@/stores/ui-store";
import { runImageQualityJob } from "@/lib/image-quality-job";

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

/** Non-archived stills carrying at least one kit-nearness tag (the corpus). */
const kitNearnessTaggedFileIds = (
    files: readonly EnteFile[],
    includeInKitNearnessByName: ReadonlyMap<string, boolean>,
): Set<number> =>
    new Set(
        files
            .filter(
                (file) =>
                    !isEnteVideoFile(file) &&
                    !isFileArchivedLocally(file) &&
                    extractUserTags(file).some((tag) =>
                        isTagIncludedInKitNearness(
                            tag,
                            includeInKitNearnessByName,
                        )),
            )
            .map((file) => file.id),
    );

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
    const [tileJobStatus, setTileJobStatus] =
        useState<BackgroundJobStatus>("idle");
    const [tileCoverage, setTileCoverage] = useState<
        KitTileEmbeddingCoverage | undefined
    >(undefined);
    const tileAbort = useRef<AbortController | undefined>(undefined);

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
    const qualityEntries = useQualityIndexStore((s) => s.entries);
    const qualityHydrated = useQualityIndexStore((s) => s.isHydrated);
    const hydrateQuality = useQualityIndexStore((s) => s.hydrate);
    const setQualityEntries = useQualityIndexStore((s) => s.setEntries);
    const includeInKitNearnessByName = useTagStore(
        (s) => s.includeInKitNearnessByName,
    );

    const clipCandidateCount = useMemo(
        () => imageFilesForPhash(allFiles, userId).length,
        [allFiles, userId],
    );
    const clipIndexedCount = embeddingEntries.size;
    const qualityCandidateCount = clipCandidateCount;
    const qualityIndexedCount = qualityEntries.size;

    useEffect(() => {
        setShowDevTools(isLocalDevToolsVisible());
    }, []);

    // Tile pilot coverage for the Developer card (local builds only).
    useEffect(() => {
        if (
            !showDevTools ||
            !embeddingHydrated ||
            allFiles.length === 0 ||
            tileJobStatus === "running"
        ) {
            return;
        }
        let cancelled = false;
        void import("@/lib/kit-tile-embedding-job")
            .then(({ kitTileEmbeddingCoverage }) =>
                kitTileEmbeddingCoverage({
                    files: allFiles,
                    userId,
                    embeddings: embeddingEntries,
                    priorityFileIds: kitNearnessTaggedFileIds(
                        allFiles,
                        includeInKitNearnessByName,
                    ),
                }))
            .then((coverage) => {
                if (!cancelled) {
                    setTileCoverage(coverage);
                }
            })
            .catch((error: unknown) => {
                console.warn("[kit-tiles] coverage failed", error);
            });
        return (): void => {
            cancelled = true;
        };
    }, [
        showDevTools,
        embeddingHydrated,
        allFiles,
        userId,
        embeddingEntries,
        includeInKitNearnessByName,
        tileJobStatus,
    ]);

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

    // Drop any stale video poster vectors once the library is known.
    useEffect(() => {
        if (!embeddingHydrated || allFiles.length === 0) {
            return;
        }
        const pruned = stripVideoEmbeddings(embeddingEntries, allFiles);
        if (pruned !== embeddingEntries) {
            setEmbeddingEntries(pruned);
        }
    }, [
        allFiles,
        embeddingEntries,
        embeddingHydrated,
        setEmbeddingEntries,
    ]);

    const handleStartClipJob = (): void => {
        if (clipJobStatus === "running") {
            return;
        }
        clipAbort.current?.abort();
        clipAbort.current = new AbortController();
        clipPaused.current = false;
        clipSmokeToastShown.current = false;
        clipBatchFallbackToastShown.current = false;
        setClipJobStatus("running");
        setClipRuntime("");
        const candidates = imageFilesForPhash(allFiles, userId);
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
            signal: clipAbort.current.signal,
            shouldPause: () => clipPaused.current,
            onProgress: (progress) => {
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

    const handleStartQualityJob = (): void => {
        if (qualityJobStatus === "running") {
            return;
        }
        qualityAbort.current?.abort();
        qualityAbort.current = new AbortController();
        qualityPaused.current = false;
        setQualityJobStatus("running");
        const candidates = imageFilesForPhash(allFiles, userId);
        const pending = candidates.filter((file) => !qualityEntries.has(file.id));
        setQualityProgress({ current: 0, total: pending.length });
        if (pending.length === 0) {
            setQualityJobStatus("done");
            toast.message("Image quality scan already complete");
            return;
        }
        void runImageQualityJob({
            files: allFiles,
            userId,
            entries: qualityEntries,
            signal: qualityAbort.current.signal,
            shouldPause: () => qualityPaused.current,
            onProgress: (current, total) => {
                setQualityProgress({ current, total });
            },
        })
            .then((entries) => {
                setQualityEntries(entries);
                if (
                    qualityAbort.current?.signal.aborted &&
                    qualityPaused.current
                ) {
                    setQualityJobStatus("paused");
                    return;
                }
                setQualityJobStatus("done");
                toast.success(
                    `Image quality scan complete — ${entries.size} scored`,
                );
            })
            .catch((error: unknown) => {
                if (qualityAbort.current?.signal.aborted) {
                    setQualityJobStatus(
                        qualityPaused.current ? "paused" : "idle",
                    );
                    return;
                }
                setQualityJobStatus("error");
                toast.error(
                    error instanceof Error ?
                        error.message :
                        "Image quality scan failed",
                );
            });
    };

    const handlePauseQualityJob = (): void => {
        qualityPaused.current = true;
        qualityAbort.current?.abort();
        setQualityJobStatus("paused");
    };

    const handleStartTileJob = (): void => {
        if (tileJobStatus === "running") {
            return;
        }
        tileAbort.current?.abort();
        tileAbort.current = new AbortController();
        const { signal } = tileAbort.current;
        setTileJobStatus("running");
        void import("@/lib/kit-tile-embedding-job")
            .then(({ runKitTileEmbeddingJob }) =>
                runKitTileEmbeddingJob({
                    files: allFiles,
                    userId,
                    embeddings: embeddingEntries,
                    priorityFileIds: kitNearnessTaggedFileIds(
                        allFiles,
                        includeInKitNearnessByName,
                    ),
                    signal,
                    onProgress: setTileCoverage,
                }))
            .then(() => {
                setTileJobStatus(signal.aborted ? "paused" : "done");
            })
            .catch((error: unknown) => {
                setTileJobStatus("error");
                toast.error(
                    error instanceof Error ? error.message : "Tile scan failed",
                );
            });
    };

    const handleClearTiles = async (): Promise<void> => {
        const { clearTileEmbeddings } = await import("@/db/tile-embeddings");
        await clearTileEmbeddings();
        setTileJobStatus("idle");
        setTileCoverage(
            (coverage) =>
                coverage && { ...coverage, completed: 0, priorityCompleted: 0 },
        );
        toast.message("Tile embeddings cleared");
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
            const { getTileEmbeddingsFor } = await import(
                "@/db/tile-embeddings"
            );
            const phashStore = usePhashIndexStore.getState();
            if (!phashStore.isHydrated) {
                await phashStore.hydrate();
            }
            const files = useLibraryStore.getState().allFiles;
            const onlyFileIds = kitNearnessTaggedFileIds(
                files,
                includeInKitNearnessByName,
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
            setCorpusExportLabel("Reading tiles…");
            const tileEmbeddings = await getTileEmbeddingsFor(
                onlyFileIds,
                KIT_EMBEDDING_MODEL_ID,
                KIT_TILE_LAYOUT_ID,
            );
            setCorpusExportLabel("Building export…");
            const corpus = buildAnonymisedKitNearnessCorpus({
                files,
                phashEntries: usePhashIndexStore.getState().entries,
                kits: useTagSpeedStore.getState().presets,
                includeInKitNearnessByName,
                embeddings,
                tileEmbeddings,
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
            const withTiles = corpus.photos.filter((photo) => photo.tiles).length;
            downloadAnonymisedKitNearnessCorpus(corpus);
            toast.success(
                `Exported ${corpus.photos.length} photos (${withVectors} with CLIP, ${withTiles} with tiles), ${corpus.kits.length} kits`,
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
                            <ToggleGroup
                                variant="outline"
                                value={[String(galleryColumns)]}
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
                                        galleryColumns:
                                            clampGalleryColumns(parsed),
                                    });
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
                                        clipEmbeddingBatchSize:
                                            clampClipEmbeddingBatchSize(
                                                parsed,
                                            ),
                                    });
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
                        Videos are never scanned.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                        {qualityHydrated ?
                            `${(
                                qualityJobStatus === "running" ?
                                    qualityIndexedCount +
                                    qualityProgress.current :
                                    qualityIndexedCount
                            ).toLocaleString()} / ${qualityCandidateCount.toLocaleString()} images scored` :
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
                            Tile pilot: embeds a 1/3-scale square grid per
                            thumbnail (≈12–15 forwards per photo) for stills that
                            already have a CLIP vector, tagged photos first; the
                            export then adds a float32 sidecar.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">
                            {tileCoverage ?
                                `Tiles: ${tileCoverage.priorityCompleted.toLocaleString()} / ${tileCoverage.priorityTotal.toLocaleString()} tagged · ${tileCoverage.completed.toLocaleString()} / ${tileCoverage.total.toLocaleString()} all` :
                                "Tiles: loading…"}
                            {tileJobStatus === "running" ? " · scanning" : null}
                            {tileJobStatus === "paused" ? " · stopped" : null}
                        </p>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                disabled={
                                    tileJobStatus === "running" ||
                                    !tileCoverage ||
                                    tileCoverage.completed >= tileCoverage.total
                                }
                                onClick={handleStartTileJob}
                            >
                                {tileCoverage &&
                                tileCoverage.completed >= tileCoverage.total ?
                                    "Tiles complete" :
                                    tileJobStatus === "paused" ?
                                        "Resume tile scan" :
                                        "Scan tiles"}
                            </Button>
                            {tileJobStatus === "running" ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => {
                                        tileAbort.current?.abort();
                                    }}
                                >
                                    Stop
                                </Button>
                            ) : null}
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={
                                    tileJobStatus === "running" ||
                                    !tileCoverage?.completed
                                }
                                onClick={() => {
                                    void handleClearTiles();
                                }}
                            >
                                Clear tiles
                            </Button>
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
                        </div>
                    </CardContent>
                </Card>
            ) : null}
        </div>
    );
}
