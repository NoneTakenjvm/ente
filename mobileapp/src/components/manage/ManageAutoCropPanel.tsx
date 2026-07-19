import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type JSX,
} from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import { getEnteCore } from "@/core";
import {
    canAutoCrop,
    encodeCroppedJpeg,
    AUTO_CROPPED_TAG,
} from "@/lib/crop";
import {
    detectContentBoundsFromBytes,
    hasMeaningfulBorder,
} from "@/lib/crop-editor";
import {
    terminateBorderScanWorker,
    thumbHasBorderInWorker,
} from "@/lib/border-scan-job";
import { getLocalMediaOverride } from "@/lib/local-media-overrides";
import { mimeTypeForFile } from "@/lib/media-kind";
import { mapBatched } from "@/lib/batched";
import { addTagNames } from "@/lib/tag-writes";
import { loadDecryptedThumbnailBytes } from "@/lib/thumbnail-cache";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import {
    isJsHeapUnderPressure,
    logJsHeap,
} from "@/lib/memory-probe";
import { useLibraryStore } from "@/stores/library-store";
import type { EnteFile } from "ente-media/file";

interface ManageAutoCropPanelProps {
    files: EnteFile[];
}

interface AutoCropCandidate {
    file: EnteFile;
}

const yieldToMain = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

const THUMB_CONCURRENCY = 1;
const APPLY_CONCURRENCY = 1;
/**
 * Cap each auto-crop run. Lower than the UI "up to 100" aspiration when the
 * heap is under pressure — phone Chrome dies long before 100 full decrypts.
 */
const AUTO_CROP_BATCH_SIZE = 100;
const AUTO_CROP_BATCH_SIZE_UNDER_PRESSURE = 20;

/**
 * Scan for images with black borders and batch-crop them.
 *
 * Acts on up to {@link AUTO_CROP_BATCH_SIZE} eligible images per run. Fetches
 * missing thumbnails on demand. Files with no border (or after a successful
 * crop) get a hidden `auto-cropped` tag so later runs skip them.
 */
export function ManageAutoCropPanel({
    files,
}: ManageAutoCropPanelProps): JSX.Element {
    const cropAndReplaceFileOptimistic = useLibraryStore(
        (s) => s.cropAndReplaceFileOptimistic,
    );
    const updateTagsOnFile = useLibraryStore((s) => s.updateTagsOnFile);
    const [scanning, setScanning] = useState<boolean>(false);
    const [applying, setApplying] = useState<boolean>(false);
    const [progress, setProgress] = useState<{ current: number; total: number }>(
        { current: 0, total: 0 },
    );
    const [statusLine, setStatusLine] = useState<string>("");
    const [candidates, setCandidates] = useState<AutoCropCandidate[]>([]);
    const [error, setError] = useState<string | undefined>();
    const [resultMessage, setResultMessage] = useState<string | undefined>();
    const scanGenerationRef = useRef<number>(0);

    useEffect(() => {
        return (): void => {
            terminateBorderScanWorker();
            scanGenerationRef.current += 1;
        };
    }, []);

    const markAutoCropped = useCallback(
        async (file: EnteFile): Promise<void> => {
            await updateTagsOnFile(file.id, (tags) => addTagNames(tags, AUTO_CROPPED_TAG));
        },
        [updateTagsOnFile],
    );

    const handleScan = useCallback(async (): Promise<void> => {
        const generation = ++scanGenerationRef.current;
        setScanning(true);
        setError(undefined);
        setResultMessage(undefined);
        setCandidates([]);
        const eligible = files.filter(
            (file) => canAutoCrop(file) && !isFileArchivedLocally(file),
        );
        const underPressure = isJsHeapUnderPressure();
        const batchSize = underPressure ?
            AUTO_CROP_BATCH_SIZE_UNDER_PRESSURE :
            AUTO_CROP_BATCH_SIZE;
        const remaining = Math.max(0, eligible.length - batchSize);
        const croppable = eligible.slice(0, batchSize);
        logJsHeap(
            underPressure ?
                "auto-crop:scan-start(pressure)" :
                "auto-crop:scan-start",
        );

        const isCancelled = (): boolean =>
            generation !== scanGenerationRef.current;

        try {
            setStatusLine(
                remaining > 0 ?
                    `Scanning batch of ${croppable.length} (${remaining} more later)…` :
                    "Loading thumbnails and scanning…",
            );
            setProgress({ current: 0, total: croppable.length });
            const likelyIds: number[] = [];
            let thumbDone = 0;
            let fetchedThumbs = 0;
            let markedClean = 0;
            let failedThumbs = 0;
            let lastProgressAt = 0;

            await mapBatched(
                croppable,
                async (file) => {
                    if (isCancelled()) {
                        return;
                    }
                    try {
                        const thumbBytes = await loadDecryptedThumbnailBytes(file);
                        fetchedThumbs += 1;
                        if (isCancelled()) {
                            return;
                        }
                        const hasBorder = await thumbHasBorderInWorker(
                            file.id,
                            thumbBytes,
                        );
                        if (hasBorder) {
                            likelyIds.push(file.id);
                        } else {
                            await markAutoCropped(file);
                            markedClean += 1;
                        }
                    } catch {
                        failedThumbs += 1;
                    } finally {
                        thumbDone += 1;
                        const now = Date.now();
                        if (
                            thumbDone === croppable.length ||
                            now - lastProgressAt >= 200
                        ) {
                            lastProgressAt = now;
                            setProgress({
                                current: thumbDone,
                                total: croppable.length,
                            });
                        }
                        if (thumbDone % 4 === 0) {
                            await yieldToMain();
                        }
                    }
                },
                { concurrency: THUMB_CONCURRENCY },
            );

            if (isCancelled()) {
                terminateBorderScanWorker();
                return;
            }

            const fileById = new Map(
                croppable.map((file) => [file.id, file] as const),
            );
            const found: AutoCropCandidate[] = likelyIds
                .map((id) => fileById.get(id))
                .filter((file): file is EnteFile => file !== undefined)
                .map((file) => ({ file }));

            terminateBorderScanWorker();
            setCandidates(found);
            setStatusLine("");
            logJsHeap("auto-crop:scan-done");
            const batchNote =
                remaining > 0 ?
                    ` ${remaining} eligible left for later runs.` :
                    "";
            const pressureNote = underPressure ?
                " (smaller batch - memory pressure)." :
                "";
            const cleanNote =
                markedClean > 0 ?
                    ` Marked ${markedClean} without borders as done.` :
                    "";
            const failNote =
                failedThumbs > 0 ?
                    ` ${failedThumbs} thumbs failed (will retry next run).` :
                    "";
            if (!found.length) {
                setResultMessage(
                    `No letterboxed images in this batch of ${fetchedThumbs}.${cleanNote}${failNote}${batchNote}${pressureNote}`,
                );
            } else {
                setResultMessage(
                    `Found ${found.length} likely letterboxed. Crop verifies each at full resolution.${cleanNote}${failNote}${batchNote}${pressureNote}`,
                );
            }
        } catch (scanError: unknown) {
            if (isCancelled()) {
                return;
            }
            setError(
                scanError instanceof Error ?
                    scanError.message :
                    "Scan failed",
            );
        } finally {
            if (!isCancelled()) {
                setScanning(false);
                setStatusLine("");
            }
        }
    }, [files, markAutoCropped]);

    const handleApply = useCallback(async (): Promise<void> => {
        if (!candidates.length) {
            return;
        }
        const generation = ++scanGenerationRef.current;
        setApplying(true);
        setError(undefined);
        setProgress({ current: 0, total: candidates.length });
        logJsHeap("auto-crop:apply-start");
        let cropped = 0;
        let marked = 0;
        let completed = 0;
        try {
            await mapBatched(
                candidates,
                async (candidate) => {
                    if (generation !== scanGenerationRef.current) {
                        return;
                    }
                    try {
                        const bytes =
                            getLocalMediaOverride(candidate.file.id) ??
                            (await getEnteCore().getDecryptedFile(
                                candidate.file,
                            ));
                        const detected = await detectContentBoundsFromBytes(
                            bytes,
                            mimeTypeForFile(candidate.file),
                        );
                        if (
                            !detected ||
                            !hasMeaningfulBorder(
                                detected.bounds,
                                detected.width,
                                detected.height,
                            )
                        ) {
                            await markAutoCropped(candidate.file);
                            marked += 1;
                            return;
                        }
                        const encoded = await encodeCroppedJpeg(
                            bytes,
                            detected.bounds,
                        );
                        const { finalize } = cropAndReplaceFileOptimistic(
                            candidate.file.id,
                            encoded.bytes,
                            {
                                width: encoded.width,
                                height: encoded.height,
                            },
                            { autoCropped: true },
                        );
                        void finalize.catch(() => {
                            // Store path handles revert/toast.
                        });
                        cropped += 1;
                    } catch {
                        // Continue batch.
                    } finally {
                        completed += 1;
                        setProgress({
                            current: completed,
                            total: candidates.length,
                        });
                        await yieldToMain();
                    }
                },
                { concurrency: APPLY_CONCURRENCY },
            );
            if (generation !== scanGenerationRef.current) {
                return;
            }
            setResultMessage(
                `Cropped ${cropped}, marked ${marked} without borders (${candidates.length} in this batch).`,
            );
            setCandidates([]);
            logJsHeap("auto-crop:apply-done");
            terminateBorderScanWorker();
        } finally {
            if (generation === scanGenerationRef.current) {
                setApplying(false);
            }
        }
    }, [candidates, cropAndReplaceFileOptimistic, markAutoCropped]);

    const handleCancel = useCallback((): void => {
        scanGenerationRef.current += 1;
        setScanning(false);
        setApplying(false);
        setStatusLine("");
        terminateBorderScanWorker();
    }, []);

    const progressPercent =
        progress.total > 0 ?
            Math.round((progress.current / progress.total) * 100) :
            0;

    const eligibleRemaining = files.filter(
        (file) => canAutoCrop(file) && !isFileArchivedLocally(file),
    ).length;

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
            <p className="text-sm text-muted-foreground">
                Processes up to {AUTO_CROP_BATCH_SIZE} images per run
                ({AUTO_CROP_BATCH_SIZE_UNDER_PRESSURE} when memory is tight).
                Missing thumbnails are downloaded during the scan. Images
                without borders are marked internally so they are not scanned
                again
                {eligibleRemaining > 0 ?
                    ` (${eligibleRemaining} still eligible).` :
                    "."}
            </p>
            <div className="flex flex-wrap gap-2">
                <Button
                    type="button"
                    onClick={() => {
                        void handleScan();
                    }}
                    disabled={scanning || applying || files.length === 0}
                >
                    {scanning ? "Scanning…" : "Scan for borders"}
                </Button>
                <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                        void handleApply();
                    }}
                    disabled={
                        applying || scanning || candidates.length === 0
                    }
                >
                    {applying ?
                        "Cropping…" :
                        `Crop ${candidates.length || ""}`.trim()}
                </Button>
                {scanning || applying ? (
                    <Button
                        type="button"
                        variant="outline"
                        onClick={handleCancel}
                    >
                        Cancel
                    </Button>
                ) : null}
            </div>
            {scanning || applying ? (
                <div className="flex flex-col gap-1">
                    <Progress value={progressPercent} className="h-1" />
                    <span className="text-xs text-muted-foreground">
                        {statusLine ? `${statusLine} ` : null}
                        {progress.current} / {progress.total}
                    </span>
                </div>
            ) : null}
            {error ? (
                <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            ) : null}
            {resultMessage ? (
                <p className="text-sm text-muted-foreground">{resultMessage}</p>
            ) : null}
            {!scanning && !candidates.length && !resultMessage ? (
                <Empty className="flex-1 border-0">
                    <EmptyHeader>
                        <EmptyTitle>Ready to scan</EmptyTitle>
                        <EmptyDescription>
                            Run a scan to find images with black borders.
                        </EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : null}
            {candidates.length > 0 ? (
                <p className="text-sm">
                    {candidates.length} image
                    {candidates.length === 1 ? "" : "s"} with borders ready to
                    crop.
                </p>
            ) : null}
        </div>
    );
}
