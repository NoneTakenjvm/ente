import {
    useCallback,
    useMemo,
    useState,
    type JSX,
} from "react";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import { CompressionPanel } from "@/components/CompressionPanel";
import { BatchCompressPreviewSheet } from "@/components/manage/BatchCompressPreviewSheet";
import { TagClausePicker } from "@/components/TagClausePicker";
import { TagQueryEditor } from "@/components/TagQueryEditor";
import { ScopeFilterMenu } from "@/components/ScopeFilterMenu";
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
import { useJob, type JobProgress } from "@/hooks/use-job";
import { useScopeCounts } from "@/hooks/use-scope-counts";
import { useTagFilterDraft } from "@/hooks/use-tag-filter-draft";
import {
    compressManageCandidates,
    DEFAULT_JPEG_QUALITY,
    DEFAULT_VIDEO_CRF,
    fileByteSize,
    filterCompressCandidatesByMinSize,
    isAlreadyCompressed,
    MIN_SIZE_FILTER_PRESETS,
    readCompressMinSizeBytes,
    sortCompressCandidatesBySize,
    writeCompressMinSizeBytes,
} from "@/lib/compress";
import { runCompressJob } from "@/lib/compress-job";
import { jobPercent } from "@/lib/job-utils";
import { mediaKindForFile } from "@/lib/media-kind";
import {
    countTagFilterClauses,
    describeTagFilter,
    emptyTagFilter,
    filterFilesByTags,
    GROUPED_TAG_FILTER_DROPDOWN_HINT,
    isFlatTagFilterRoot,
    isTagFilterActive,
} from "@/lib/tag-filter";
import { VIDEO_COMPRESS_BATCH_MAX_LONG_EDGE } from "@/lib/transcode/compress-media";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useTagStore } from "@/stores/tag-store";
import { ListFilter } from "lucide-react";
import type { EnteFile } from "ente-media/file";
import { errorMessage, formatFileSize, plural } from "@/lib/format";

const COMPRESS_FOOTER_INSET_PX = 220;

interface CompressProgress extends JobProgress {
    stage: string;
    fileLabel: string;
    ratio?: number;
    encoder?: string;
}

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
        (s) => s.typeConfig.includeInEffectsPresenceByName,
    );

    const { filter, actions, setFilter } = useTagFilterDraft();

    const job = useJob<CompressProgress>();
    const [jobError, setJobError] = useState<string | undefined>();

    const [includePreviouslyCompressed, setIncludePreviouslyCompressed] =
        useState<boolean>(false);
    const [minSizeBytes, setMinSizeBytes] = useState<number>(
        readCompressMinSizeBytes,
    );
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [batchPreviewOpen, setBatchPreviewOpen] = useState<boolean>(false);
    const [resultMessage, setResultMessage] = useState<string | undefined>();
    const [compressTarget, setCompressTarget] = useState<EnteFile | undefined>();

    const scopeCounts = useScopeCounts(files);

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
            parts.push(`${plural(photos, "photo")}`);
        }
        if (videos > 0) {
            parts.push(`${plural(videos, "video")}`);
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

    const selectMany = useCallback((fileIds: number[], mode: "add" | "toggle" | "set"): void => {
        setSelectedIds((current) => {
            if (mode === "set") {
                const next = new Set<number>();
                for (const fileId of fileIds) {
                    if (candidateIds.has(fileId)) {
                        next.add(fileId);
                    }
                }
                return next;
            }
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

    const handleStartJob = (): void => {
        if (job.status === "running" || activeSelectedIds.size === 0) {
            return;
        }

        setJobError(undefined);
        setResultMessage(undefined);
        setBatchPreviewOpen(false);

        job.start(
            (signal, onProgress) => {
                onProgress({
                    current: 0,
                    total: activeSelectedIds.size,
                    stage: "download",
                    fileLabel: "",
                });
                return runCompressJob({
                    files: candidates,
                    fileIds: activeSelectedIds,
                    includePreviouslyCompressed,
                    quality: DEFAULT_JPEG_QUALITY,
                    videoCrf: DEFAULT_VIDEO_CRF,
                    minSizeBytes,
                    maxLongEdge: VIDEO_COMPRESS_BATCH_MAX_LONG_EDGE,
                    signal,
                    onProgress,
                    downloadFile: async (file, onDownloadProgress) => {
                        const { loadMediaBytesForEdit } = await import(
                            "@/lib/load-media-bytes"
                        );
                        return loadMediaBytesForEdit(file, (progress) => {
                            const total = progress.total > 0 ? progress.total : progress.loaded;
                            onDownloadProgress(total > 0 ? progress.loaded / total : undefined);
                        });
                    },
                    compressFile: (fileId, bytes, options) =>
                        compressAndUploadMedia(fileId, bytes, options),
                });
            },
            {
                onFinish: (result, aborted) => {
                    if (aborted) {
                        return;
                    }
                    const parts = [
                        `Compressed ${plural(result.completed, "file")}`,
                    ];
                    if (result.skipped > 0) {
                        parts.push(`${result.skipped} skipped`);
                    }
                    if (result.failed > 0) {
                        parts.push(`${result.failed} failed`);
                    }
                    setResultMessage(parts.join(" · "));
                },
                onError: (error) => {
                    setJobError(
                        errorMessage(error, "Compression job failed"),
                    );
                },
            },
        );
    };

    const handleReviewCompression = (): void => {
        if (activeSelectedIds.size === 0 || job.status === "running") {
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

    const handleReset = (): void => {
        job.reset();
        setJobError(undefined);
    };

    const jobRunning = job.status === "running";
    const jobProgress = job.progress;
    const stageRatioPercent =
        jobProgress?.ratio !== undefined ?
            Math.round(jobProgress.ratio * 100) :
            undefined;

    const gridSelection = useMemo(
        () => ({
            selectedIds: activeSelectedIds,
            onToggle: toggleFile,
            onSelectMany: selectMany,
            onSetSelection: (fileIds: number[]): void => {
                selectMany(fileIds, "set");
            },
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
        filter.croppedScope !== "all" ||
        filter.rotatedScope !== "all";

    const encoderHint =
        jobProgress?.encoder === "webcodecs" ?
            "Hardware H.264" :
            jobProgress?.encoder === "ffmpeg" ?
                "ffmpeg (CPU)" :
                jobProgress?.encoder === "photohoard" ?
                    "AVIF/WebP" :
                    undefined;

    return (
        <>
            <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3">
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <ScopeFilterMenu
                        filter={filter}
                        setScope={actions.setScope}
                        counts={scopeCounts}
                    />
                    <TagClausePicker
                        filter={filter}
                        onSetTagFilterMode={actions.setTagFilterMode}
                        onSetKitMode={actions.setKitMode}
                        onSetRootOp={(op) => {
                            actions.setGroupOp(filter.root.id, op);
                        }}
                        triggerLabel={
                            clauseCount === 0 ?
                                "Tags" :
                                `${plural(clauseCount, "tag")}`
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
                                    counts={scopeCounts}
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
                        {plural(candidates.length, "compressible file")} · {activeSelectedIds.size} selected
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
                                onClick={job.pause}
                            >
                                Pause
                            </Button>
                            <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                onClick={handleReset}
                            >
                                Stop
                            </Button>
                        </>
                    ) : null}
                    {job.status === "paused" ? (
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
                                onClick={handleReset}
                            >
                                Stop
                            </Button>
                        </>
                    ) : null}
                    {job.status === "done" || job.status === "error" ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={handleReset}
                        >
                            Reset
                        </Button>
                    ) : null}
                </div>

                {jobRunning && jobProgress ? (
                    <div className="flex flex-col gap-1">
                        <Progress
                            value={jobPercent(
                                jobProgress.current,
                                jobProgress.total,
                                jobProgress.ratio,
                            )}
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
