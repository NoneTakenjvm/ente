import {
    useCallback,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import { CompressionPanel } from "@/components/CompressionPanel";
import { BatchCompressPreviewSheet } from "@/components/manage/BatchCompressPreviewSheet";
import { TagClausePicker } from "@/components/TagClausePicker";
import { TagQueryEditor } from "@/components/TagQueryEditor";
import { TagScopeFilterDropdown } from "@/components/TagScopeFilterDropdown";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useTagFilterDraft } from "@/hooks/use-tag-filter-draft";
import {
    compressManageCandidates,
    DEFAULT_JPEG_QUALITY,
    DEFAULT_VIDEO_CRF,
    fileByteSize,
    filterCompressCandidatesByMinSize,
    formatFileSize,
    isAlreadyCompressed,
    MIN_SIZE_FILTER_PRESETS,
    readCompressMinSizeBytes,
    sortCompressCandidatesBySize,
    writeCompressMinSizeBytes,
} from "@/lib/compress";
import { runCompressJob } from "@/lib/compress-job";
import { mediaKindForFile } from "@/lib/media-kind";
import {
    countFavoritesInCandidates,
    countFileKindsInCandidates,
    countTagFilterClauses,
    countTaggedInCandidates,
    describeTagFilter,
    emptyTagFilter,
    filterFilesByTags,
    GROUPED_TAG_FILTER_DROPDOWN_HINT,
    isFlatTagFilterRoot,
    isTagFilterActive,
} from "@/lib/tags";
import { VIDEO_COMPRESS_BATCH_MAX_LONG_EDGE } from "@/lib/transcode/compress-media";
import { useCompressJobStore } from "@/stores/ui-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useTagStore } from "@/stores/tag-store";
import { ListFilter } from "lucide-react";
import type { EnteFile } from "ente-media/file";

const COMPRESS_FOOTER_INSET_PX = 220;

interface ManageCompressPanelProps {
    files: EnteFile[];
    libraryLoaded: boolean;
}

const stageLabel = (stage: string): string => {
    switch (stage) {
        case "download":
            return "Downloading";
        case "compress":
            return "Compressing";
        case "upload":
            return "Uploading";
        case "skip":
            return "Skipped";
        case "done":
            return "Done";
        case "error":
            return "Failed";
        default:
            return "Working";
    }
};

export function ManageCompressPanel({
    files,
    libraryLoaded,
}: ManageCompressPanelProps): JSX.Element {
    const compressAndUploadMedia = useLibraryStore((s) => s.compressAndUploadMedia);
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const includeInEffectsPresenceByName = useTagStore(
        (s) => s.includeInEffectsPresenceByName,
    );

    const { filter, actions, setFilter } = useTagFilterDraft();

    const jobStatus = useCompressJobStore((s) => s.status);
    const jobProgress = useCompressJobStore((s) => s.progress);
    const jobError = useCompressJobStore((s) => s.error);
    const setJobError = useCompressJobStore((s) => s.setError);
    const setJobStatus = useCompressJobStore((s) => s.setStatus);
    const setJobProgress = useCompressJobStore((s) => s.setProgress);
    const resetJob = useCompressJobStore((s) => s.reset);

    const [includePreviouslyCompressed, setIncludePreviouslyCompressed] =
        useState<boolean>(false);
    const [minSizeBytes, setMinSizeBytes] = useState<number>(
        readCompressMinSizeBytes,
    );
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [batchPreviewOpen, setBatchPreviewOpen] = useState<boolean>(false);
    const [resultMessage, setResultMessage] = useState<string | undefined>();
    const [compressTarget, setCompressTarget] = useState<EnteFile | undefined>();

    const jobAbort = useRef<AbortController | undefined>(undefined);
    const jobPaused = useRef<boolean>(false);
    const jobStopped = useRef<boolean>(false);

    const libraryFileIds = useMemo(
        (): Set<number> => new Set(files.map((file) => file.id)),
        [files],
    );

    const taggedCount = useMemo(
        (): number =>
            countTaggedInCandidates(
                libraryFileIds,
                fileIdsByTag,
                includeInEffectsPresenceByName,
            ),
        [fileIdsByTag, includeInEffectsPresenceByName, libraryFileIds],
    );
    const untaggedCount = libraryFileIds.size - taggedCount;
    const favoritesCount = useMemo(
        (): number =>
            countFavoritesInCandidates(libraryFileIds, favoriteFileIds),
        [favoriteFileIds, libraryFileIds],
    );
    const notFavoritesCount = libraryFileIds.size - favoritesCount;
    const fileKindCounts = useMemo(
        (): ReturnType<typeof countFileKindsInCandidates> =>
            countFileKindsInCandidates(libraryFileIds, files),
        [files, libraryFileIds],
    );

    const tagFiltered = useMemo(
        () =>
            filterFilesByTags(files, filter, fileIdsByTag, {
                favoriteFileIds,
                includeInEffectsPresenceByName,
            }),
        [
            favoriteFileIds,
            fileIdsByTag,
            files,
            filter,
            includeInEffectsPresenceByName,
        ],
    );

    const baseCandidates = useMemo(
        () =>
            compressManageCandidates(
                tagFiltered,
                includePreviouslyCompressed,
            ),
        [includePreviouslyCompressed, tagFiltered],
    );
    const candidates = useMemo(
        () =>
            sortCompressCandidatesBySize(
                filterCompressCandidatesByMinSize(baseCandidates, minSizeBytes),
            ),
        [baseCandidates, minSizeBytes],
    );
    const candidateIds = useMemo(
        () => new Set(candidates.map((file) => file.id)),
        [candidates],
    );

    const activeSelectedIds = useMemo(() => {
        const next = new Set<number>();
        for (const fileId of selectedIds) {
            if (candidateIds.has(fileId)) {
                next.add(fileId);
            }
        }
        return next;
    }, [candidateIds, selectedIds]);

    const selectedFiles = useMemo(
        () => candidates.filter((file) => activeSelectedIds.has(file.id)),
        [activeSelectedIds, candidates],
    );

    const selectionSummary = useMemo((): string => {
        if (selectedFiles.length === 0) {
            return "Nothing selected";
        }
        let photos = 0;
        let videos = 0;
        let knownBytes = 0;
        let unknown = 0;
        for (const file of selectedFiles) {
            const kind = mediaKindForFile(file);
            if (kind === "video") {
                videos += 1;
            } else {
                photos += 1;
            }
            const size = fileByteSize(file);
            if (size > 0) {
                knownBytes += size;
            } else {
                unknown += 1;
            }
        }
        const parts: string[] = [];
        if (photos > 0) {
            parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
        }
        if (videos > 0) {
            parts.push(`${videos} video${videos === 1 ? "" : "s"}`);
        }
        if (knownBytes > 0) {
            parts.push(formatFileSize(knownBytes));
        }
        if (unknown > 0) {
            parts.push(knownBytes > 0 ? "+ unknown" : "size unknown");
        }
        return parts.join(" · ");
    }, [selectedFiles]);

    const toggleFile = useCallback((file: EnteFile): void => {
        setSelectedIds((current) => {
            const next = new Set(current);
            if (next.has(file.id)) {
                next.delete(file.id);
            } else {
                next.add(file.id);
            }
            return next;
        });
    }, []);

    const selectMany = useCallback((fileIds: number[], mode: "add" | "toggle"): void => {
        setSelectedIds((current) => {
            const next = new Set(current);
            for (const fileId of fileIds) {
                if (!candidateIds.has(fileId)) {
                    continue;
                }
                if (mode === "add") {
                    next.add(fileId);
                } else if (next.has(fileId)) {
                    next.delete(fileId);
                } else {
                    next.add(fileId);
                }
            }
            return next;
        });
    }, [candidateIds]);

    const allSelectableSelected =
        candidates.length > 0 &&
        candidates.every((file) => activeSelectedIds.has(file.id));

    const toggleAll = (): void => {
        setSelectedIds(
            allSelectableSelected ?
                new Set() :
                new Set(candidates.map((file) => file.id)),
        );
    };

    const handleIncludeToggle = (): void => {
        setIncludePreviouslyCompressed((current) => !current);
    };

    const handleStartJob = useCallback((): void => {
        if (jobStatus === "running" || activeSelectedIds.size === 0) {
            return;
        }

        jobStopped.current = false;
        jobAbort.current?.abort();
        jobAbort.current = new AbortController();
        jobPaused.current = false;
        setJobError(undefined);
        setResultMessage(undefined);
        setJobStatus("running");
        setJobProgress({
            current: 0,
            total: activeSelectedIds.size,
            stage: "download",
            fileLabel: "",
        });
        setBatchPreviewOpen(false);

        void runCompressJob({
            files: candidates,
            fileIds: activeSelectedIds,
            includePreviouslyCompressed,
            quality: DEFAULT_JPEG_QUALITY,
            videoCrf: DEFAULT_VIDEO_CRF,
            minSizeBytes,
            maxLongEdge: VIDEO_COMPRESS_BATCH_MAX_LONG_EDGE,
            signal: jobAbort.current.signal,
            shouldPause: () => jobPaused.current,
            onProgress: (update) => {
                setJobProgress({
                    current: update.current,
                    total: update.total,
                    stage: update.stage,
                    fileLabel: update.fileLabel,
                    ratio: update.ratio,
                    encoder: update.encoder,
                });
            },
            compressFile: (fileId, options) =>
                compressAndUploadMedia(fileId, options),
        })
            .then((result) => {
                if (jobStopped.current) {
                    return;
                }
                if (jobAbort.current?.signal.aborted && jobPaused.current) {
                    setJobStatus("paused");
                    return;
                }
                setJobStatus("done");
                const parts = [
                    `Compressed ${result.completed} file${result.completed === 1 ? "" : "s"}`,
                ];
                if (result.skipped > 0) {
                    parts.push(`${result.skipped} skipped`);
                }
                if (result.failed > 0) {
                    parts.push(`${result.failed} failed`);
                }
                setResultMessage(parts.join(" · "));
            })
            .catch((error: unknown) => {
                if (jobStopped.current) {
                    return;
                }
                if (jobAbort.current?.signal.aborted && jobPaused.current) {
                    setJobStatus("paused");
                    return;
                }
                setJobStatus("error");
                setJobError(
                    error instanceof Error ?
                        error.message :
                        "Compression job failed",
                );
            });
    }, [
        activeSelectedIds,
        candidates,
        compressAndUploadMedia,
        includePreviouslyCompressed,
        setJobError,
        jobStatus,
        minSizeBytes,
        setJobProgress,
        setJobStatus,
    ]);

    const handleReviewCompression = (): void => {
        if (activeSelectedIds.size === 0 || jobStatus === "running") {
            return;
        }
        if (activeSelectedIds.size === 1) {
            const file = selectedFiles[0];
            if (file) {
                setCompressTarget(file);
            }
            return;
        }
        setBatchPreviewOpen(true);
    };

    const handlePauseJob = (): void => {
        jobPaused.current = true;
        jobAbort.current?.abort();
        setJobStatus("paused");
    };

    const handleStopJob = (): void => {
        jobStopped.current = true;
        jobPaused.current = false;
        jobAbort.current?.abort();
        resetJob();
    };

    const jobRunning = jobStatus === "running";
    const stageRatioPercent =
        jobProgress.ratio !== undefined ?
            Math.round(jobProgress.ratio * 100) :
            undefined;
    const progressPercent =
        jobProgress.total > 0 ?
            Math.round(
                ((jobProgress.current - (stageRatioPercent !== undefined ?
                    (100 - stageRatioPercent) / 100 :
                    0)) /
                    jobProgress.total) *
                    100,
            ) :
            0;
    const barPercent =
        stageRatioPercent !== undefined && jobProgress.total > 0 ?
            Math.round(
                ((jobProgress.current - 1) / jobProgress.total) * 100 +
                    stageRatioPercent / jobProgress.total,
            ) :
            progressPercent;

    const gridSelection = useMemo(
        () => ({
            selectedIds: activeSelectedIds,
            onToggle: toggleFile,
            onSelectMany: selectMany,
            isAlreadyCompressed,
            disabled: jobRunning,
        }),
        [activeSelectedIds, jobRunning, selectMany, toggleFile],
    );

    const minSizePreset = MIN_SIZE_FILTER_PRESETS.find(
        (preset) => preset.bytes === minSizeBytes,
    ) ?? MIN_SIZE_FILTER_PRESETS[0]!;

    const clauseCount = countTagFilterClauses(filter.root);
    const filterActive = isTagFilterActive(filter);
    const isFlat = isFlatTagFilterRoot(filter.root);
    const hasQueryContent =
        clauseCount > 0 ||
        filter.tagScope !== "all" ||
        filter.favoritesScope !== "all" ||
        filter.mediaScope !== "all" ||
        filter.croppedScope !== "all";

    const encoderHint =
        jobProgress.encoder === "webcodecs" ?
            "Hardware H.264" :
            jobProgress.encoder === "ffmpeg" ?
                "ffmpeg (CPU)" :
                jobProgress.encoder === "photohoard" ?
                    "AVIF/WebP" :
                    undefined;

    return (
        <>
            <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3">
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <TagScopeFilterDropdown
                        taggedCount={taggedCount}
                        untaggedCount={untaggedCount}
                        favoritesCount={favoritesCount}
                        notFavoritesCount={notFavoritesCount}
                        photoCount={fileKindCounts.photos}
                        videoCount={fileKindCounts.videos}
                        croppedCount={fileKindCounts.cropped}
                        notCroppedCount={fileKindCounts.notCropped}
                        tagScope={filter.tagScope}
                        onTagScopeChange={actions.setTagScope}
                        favoritesScope={filter.favoritesScope}
                        onFavoritesScopeChange={actions.setFavoritesScope}
                        mediaScope={filter.mediaScope}
                        onMediaScopeChange={actions.setMediaScope}
                        croppedScope={filter.croppedScope}
                        onCroppedScopeChange={actions.setCroppedScope}
                    />
                    <TagClausePicker
                        filter={filter}
                        onSetTagFilterMode={actions.setTagFilterMode}
                        onSetKitTagsMode={actions.setKitTagsMode}
                        onSetRootOp={(op) => {
                            actions.setGroupOp(filter.root.id, op);
                        }}
                        triggerLabel={
                            clauseCount === 0 ?
                                "Tags" :
                                `${clauseCount} tag${clauseCount === 1 ? "" : "s"}`
                        }
                        triggerVariant={clauseCount > 0 ? "secondary" : "outline"}
                        disabled={!isFlat || jobRunning}
                    />
                    <DropdownMenu>
                        <DropdownMenuTrigger
                            render={
                                <Button
                                    type="button"
                                    variant={hasQueryContent ? "secondary" : "outline"}
                                    size="icon-sm"
                                    disabled={jobRunning}
                                    aria-label="Edit tag query"
                                >
                                    <ListFilter />
                                </Button>
                            }
                        />
                        <DropdownMenuContent
                            align="start"
                            className="flex max-h-[min(80dvh,28rem)] w-[min(100vw-2rem,24rem)] flex-col overflow-x-hidden overflow-y-auto overscroll-contain p-2"
                        >
                            <DropdownMenuGroup className="flex min-h-0 flex-1 flex-col gap-3">
                                <DropdownMenuLabel className="shrink-0 px-0">
                                    Query builder
                                </DropdownMenuLabel>
                                <TagQueryEditor
                                    filter={filter}
                                    actions={actions}
                                    taggedCount={taggedCount}
                                    untaggedCount={untaggedCount}
                                    favoritesCount={favoritesCount}
                                    notFavoritesCount={notFavoritesCount}
                                    photoCount={fileKindCounts.photos}
                                    videoCount={fileKindCounts.videos}
                                    croppedCount={fileKindCounts.cropped}
                                    notCroppedCount={fileKindCounts.notCropped}
                                />
                            </DropdownMenuGroup>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    {!isFlat ? (
                        <p className="w-full text-xs text-muted-foreground">
                            {GROUPED_TAG_FILTER_DROPDOWN_HINT}
                        </p>
                    ) : null}
                </div>

                {filterActive ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-muted-foreground">
                            {describeTagFilter(filter)}
                        </span>
                        <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={jobRunning}
                            onClick={() => setFilter(emptyTagFilter())}
                        >
                            Clear
                        </Button>
                    </div>
                ) : null}

                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                        {candidates.length} compressible file
                        {candidates.length === 1 ? "" : "s"} · {activeSelectedIds.size} selected
                        {libraryLoaded ? "" : " · loading…"}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant={includePreviouslyCompressed ? "default" : "outline"}
                            size="sm"
                            disabled={jobRunning}
                            onClick={handleIncludeToggle}
                        >
                            {includePreviouslyCompressed ?
                                "Including compressed" :
                                "Skip compressed"}
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={jobRunning || candidates.length === 0}
                            onClick={toggleAll}
                        >
                            {allSelectableSelected ? "Deselect all" : "Select all"}
                        </Button>
                    </div>
                </div>

                <Field>
                    <FieldLabel>Minimum file size</FieldLabel>
                    <Select
                        value={String(minSizeBytes)}
                        disabled={jobRunning}
                        onValueChange={(value) => {
                            const next = Number(value);
                            setMinSizeBytes(next);
                            writeCompressMinSizeBytes(next);
                        }}
                    >
                        <SelectTrigger className="w-full">
                            <SelectValue>{minSizePreset.label}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {MIN_SIZE_FILTER_PRESETS.map((preset) => (
                                <SelectItem
                                    key={preset.bytes}
                                    value={String(preset.bytes)}
                                >
                                    {preset.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>

                <ThumbnailGrid
                    files={candidates}
                    selection={gridSelection}
                    footerInsetPx={COMPRESS_FOOTER_INSET_PX}
                    showFileSize
                />

                {resultMessage ? (
                    <Alert className="shrink-0">
                        <AlertDescription>{resultMessage}</AlertDescription>
                    </Alert>
                ) : null}

                {jobError ? (
                    <Alert variant="destructive" className="shrink-0">
                        <AlertDescription>{jobError}</AlertDescription>
                    </Alert>
                ) : null}
            </div>

            <footer className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex flex-col gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
                {!jobRunning ? (
                    <p className="text-sm text-muted-foreground">{selectionSummary}</p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        size="sm"
                        onClick={handleReviewCompression}
                        disabled={jobRunning || activeSelectedIds.size === 0}
                    >
                        Compress selected
                    </Button>
                    {jobRunning ? (
                        <>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={handlePauseJob}
                            >
                                Pause
                            </Button>
                            <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                onClick={handleStopJob}
                            >
                                Stop
                            </Button>
                        </>
                    ) : null}
                    {jobStatus === "paused" ? (
                        <>
                            <Button
                                type="button"
                                size="sm"
                                onClick={handleStartJob}
                            >
                                Resume
                            </Button>
                            <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                onClick={handleStopJob}
                            >
                                Stop
                            </Button>
                        </>
                    ) : null}
                    {jobStatus === "done" || jobStatus === "error" ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={resetJob}
                        >
                            Reset
                        </Button>
                    ) : null}
                </div>

                {jobRunning ? (
                    <div className="flex flex-col gap-1">
                        <Progress
                            value={Math.min(100, Math.max(0, barPercent))}
                            className="h-1"
                        />
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Spinner className="size-3" />
                            {jobProgress.current} / {jobProgress.total}
                            {jobProgress.fileLabel ?
                                ` · ${jobProgress.fileLabel}` :
                                ""}
                            {" · "}
                            {stageLabel(jobProgress.stage)}
                            {stageRatioPercent !== undefined ?
                                ` ${stageRatioPercent}%` :
                                ""}
                            {encoderHint ? ` · ${encoderHint}` : ""}
                        </span>
                    </div>
                ) : null}
            </footer>

            <BatchCompressPreviewSheet
                open={batchPreviewOpen}
                files={selectedFiles}
                minSizeLabel={minSizePreset.label}
                onClose={() => setBatchPreviewOpen(false)}
                onConfirm={handleStartJob}
            />

            {compressTarget ? (
                <CompressionPanel
                    file={compressTarget}
                    onClose={() => setCompressTarget(undefined)}
                    onUploaded={() => setCompressTarget(undefined)}
                />
            ) : null}
        </>
    );
}
