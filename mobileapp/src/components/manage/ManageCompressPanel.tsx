import {
    useCallback,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import { CompressionPanel } from "@/components/CompressionPanel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import {
    compressManageCandidates,
    DEFAULT_JPEG_QUALITY,
    isAlreadyCompressed,
    MAX_JPEG_QUALITY,
    MIN_JPEG_QUALITY,
} from "@/lib/compress";
import { runCompressJob } from "@/lib/compress-job";
import { useCompressJobStore } from "@/stores/ui-store";
import { useLibraryStore } from "@/stores/library-store";
import type { EnteFile } from "ente-media/file";

const DEFAULT_VIDEO_CRF = 28;
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
    const candidates = useMemo(
        () => compressManageCandidates(files, includePreviouslyCompressed),
        [files, includePreviouslyCompressed],
    );
    const candidateIds = useMemo(
        () => new Set(candidates.map((file) => file.id)),
        [candidates],
    );

    const [selectedIds, setSelectedIds] = useState<Set<number> | null>(null);
    const [quality, setQuality] = useState<number>(DEFAULT_JPEG_QUALITY);
    const [videoCrf, setVideoCrf] = useState<number>(DEFAULT_VIDEO_CRF);
    const [resultMessage, setResultMessage] = useState<string | undefined>();
    const [compressTarget, setCompressTarget] = useState<EnteFile | undefined>();

    const jobAbort = useRef<AbortController | undefined>(undefined);
    const jobPaused = useRef<boolean>(false);

    const defaultSelectedIds = useMemo(
        () =>
            new Set(
                candidates
                    .filter((file) => !isAlreadyCompressed(file))
                    .map((file) => file.id),
            ),
        [candidates],
    );

    const resolvedSelectedIds =
        selectedIds ?? (libraryLoaded ? defaultSelectedIds : new Set<number>());

    const activeSelectedIds = useMemo(() => {
        const next = new Set<number>();
        for (const fileId of resolvedSelectedIds) {
            if (candidateIds.has(fileId)) {
                next.add(fileId);
            }
        }
        return next;
    }, [candidateIds, resolvedSelectedIds]);

    const toggleFile = useCallback((file: EnteFile): void => {
        setSelectedIds((current) => {
            const base = current ?? defaultSelectedIds;
            const next = new Set(base);
            if (next.has(file.id)) {
                next.delete(file.id);
            } else {
                next.add(file.id);
            }
            return next;
        });
    }, [defaultSelectedIds]);

    const selectMany = useCallback((fileIds: number[], mode: "add" | "toggle"): void => {
        setSelectedIds((current) => {
            const base = current ?? defaultSelectedIds;
            const next = new Set(base);
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
    }, [candidateIds, defaultSelectedIds]);

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
        setIncludePreviouslyCompressed((current) => {
            const next = !current;
            if (!next) {
                setSelectedIds((selected) => {
                    const base = selected ?? defaultSelectedIds;
                    const filtered = new Set<number>();
                    for (const fileId of base) {
                        const file = files.find((entry) => entry.id === fileId);
                        if (file && !isAlreadyCompressed(file)) {
                            filtered.add(fileId);
                        }
                    }
                    return filtered;
                });
            }
            return next;
        });
    };

    const handleStartJob = useCallback((): void => {
        if (jobStatus === "running" || activeSelectedIds.size === 0) {
            return;
        }

        jobAbort.current?.abort();
        jobAbort.current = new AbortController();
        jobPaused.current = false;
        setJobError(undefined);
        setResultMessage(undefined);
        setJobStatus("running");
        setJobProgress(0, activeSelectedIds.size);

        void runCompressJob({
            files: candidates,
            fileIds: activeSelectedIds,
            includePreviouslyCompressed,
            quality,
            videoCrf,
            signal: jobAbort.current.signal,
            shouldPause: () => jobPaused.current,
            onProgress: setJobProgress,
            compressFile: (fileId, options) =>
                compressAndUploadMedia(fileId, options),
        })
            .then((result) => {
                if (jobAbort.current?.signal.aborted) {
                    setJobStatus("paused");
                    return;
                }
                setJobStatus("done");
                setResultMessage(
                    `Compressed ${result.completed} file${result.completed === 1 ? "" : "s"}${result.failed > 0 ? ` · ${result.failed} failed` : ""}`,
                );
            })
            .catch((error: unknown) => {
                if (jobAbort.current?.signal.aborted) {
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
        quality,
        setJobProgress,
        setJobStatus,
        videoCrf,
    ]);

    const handlePauseJob = (): void => {
        jobPaused.current = true;
        jobAbort.current?.abort();
        setJobStatus("paused");
    };

    const progressPercent =
        jobProgress.total > 0 ?
            Math.round((jobProgress.current / jobProgress.total) * 100) :
            0;

    const qualityPercent = Math.round(quality * 100);
    const jobRunning = jobStatus === "running";

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

    return (
        <>
            <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3">
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                        {candidates.length} compressible file
                        {candidates.length === 1 ? "" : "s"} · {activeSelectedIds.size} selected
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

                <ThumbnailGrid
                    files={candidates}
                    selection={gridSelection}
                    onOpenFile={setCompressTarget}
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
                <Field>
                    <FieldLabel>JPEG quality {qualityPercent}%</FieldLabel>
                    <Slider
                        min={MIN_JPEG_QUALITY * 100}
                        max={MAX_JPEG_QUALITY * 100}
                        value={[qualityPercent]}
                        disabled={jobRunning}
                        onValueChange={(value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            if (next !== undefined) {
                                setQuality(next / 100);
                            }
                        }}
                    />
                </Field>

                <Field>
                    <FieldLabel>Video CRF {videoCrf}</FieldLabel>
                    <Slider
                        min={18}
                        max={32}
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

                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        size="sm"
                        onClick={handleStartJob}
                        disabled={jobRunning || activeSelectedIds.size === 0}
                    >
                        {jobStatus === "paused" ? "Resume" : "Compress selected"}
                    </Button>
                    {jobRunning ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={handlePauseJob}
                        >
                            Pause
                        </Button>
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
