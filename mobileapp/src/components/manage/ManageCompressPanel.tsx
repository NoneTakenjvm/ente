import {
    useCallback,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import { Settings } from "lucide-react";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import { CompressionPanel } from "@/components/CompressionPanel";
import { BatchCompressPreviewSheet } from "@/components/manage/BatchCompressPreviewSheet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import {
    compressManageCandidates,
    DEFAULT_JPEG_QUALITY,
    DEFAULT_VIDEO_CRF,
    filterCompressCandidatesByMinSize,
    isAlreadyCompressed,
    MAX_VIDEO_CRF,
    MIN_SIZE_FILTER_PRESETS,
    MIN_VIDEO_CRF,
    readCompressMinSizeBytes,
    sortCompressCandidatesBySize,
    writeCompressMinSizeBytes,
} from "@/lib/compress";
import { runCompressJob } from "@/lib/compress-job";
import { useCompressJobStore } from "@/stores/ui-store";
import { useLibraryStore } from "@/stores/library-store";
import type { EnteFile } from "ente-media/file";

const COMPRESS_FOOTER_INSET_PX = 220;

interface ManageCompressPanelProps {
    files: EnteFile[];
    libraryLoaded: boolean;
}

export function ManageCompressPanel({
    files,
    libraryLoaded,
}: ManageCompressPanelProps): JSX.Element {
    const compressAndUploadMedia = useLibraryStore((s) => s.compressAndUploadMedia);

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
    const [videoCrf, setVideoCrf] = useState<number>(DEFAULT_VIDEO_CRF);
    const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
    const [batchPreviewOpen, setBatchPreviewOpen] = useState<boolean>(false);
    const [resultMessage, setResultMessage] = useState<string | undefined>();
    const [compressTarget, setCompressTarget] = useState<EnteFile | undefined>();

    const jobAbort = useRef<AbortController | undefined>(undefined);
    const jobPaused = useRef<boolean>(false);
    const jobStopped = useRef<boolean>(false);

    const baseCandidates = useMemo(
        () => compressManageCandidates(files, includePreviouslyCompressed),
        [files, includePreviouslyCompressed],
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
        setJobProgress(0, activeSelectedIds.size);
        setBatchPreviewOpen(false);

        void runCompressJob({
            files: candidates,
            fileIds: activeSelectedIds,
            includePreviouslyCompressed,
            quality: DEFAULT_JPEG_QUALITY,
            videoCrf,
            minSizeBytes,
            signal: jobAbort.current.signal,
            shouldPause: () => jobPaused.current,
            onProgress: setJobProgress,
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
        videoCrf,
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

    const progressPercent =
        jobProgress.total > 0 ?
            Math.round((jobProgress.current / jobProgress.total) * 100) :
            0;

    const jobRunning = jobStatus === "running";
    const settingsSummary = `Video CRF ${videoCrf}`;

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

    return (
        <>
            <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3">
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
                <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-muted-foreground">{settingsSummary}</p>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={jobRunning}
                        onClick={() => setSettingsOpen(true)}
                    >
                        <Settings className="size-4" />
                        Settings
                    </Button>
                </div>

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
                        <Progress value={progressPercent} className="h-1" />
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Spinner className="size-3" />
                            Compressing {jobProgress.current} / {jobProgress.total}
                        </span>
                    </div>
                ) : null}
            </footer>

            <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Compression settings</DialogTitle>
                    </DialogHeader>
                    <Field>
                        <FieldLabel>Video CRF {videoCrf}</FieldLabel>
                        <Slider
                            min={MIN_VIDEO_CRF}
                            max={MAX_VIDEO_CRF}
                            value={[videoCrf]}
                            disabled={jobRunning}
                            onValueChange={(value) => {
                                const next = Array.isArray(value) ? value[0] : value;
                                if (next !== undefined) {
                                    setVideoCrf(next);
                                }
                            }}
                        />
                    </Field>
                    <DialogFooter>
                        <Button type="button" onClick={() => setSettingsOpen(false)}>
                            Done
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <BatchCompressPreviewSheet
                open={batchPreviewOpen}
                files={selectedFiles}
                minSizeLabel={minSizePreset.label}
                videoCrf={videoCrf}
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
