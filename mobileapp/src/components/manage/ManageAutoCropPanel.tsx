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
import { canCrop, encodeCroppedJpeg } from "@/lib/crop";
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
import { loadCachedDecryptedThumbnailBytes } from "@/lib/thumbnail-cache";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
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
 * Scan for images with black borders and batch-crop them.
 *
 * Uses locally cached thumbnails only (mass thumbnail downloads OOM mobile
 * Chrome). Exact crop bounds are computed one-at-a-time during Apply — a
 * bulk full-file decrypt pass also kills the tab on large candidate sets.
 */
export function ManageAutoCropPanel({
    files,
}: ManageAutoCropPanelProps): JSX.Element {
    const cropAndReplaceFileOptimistic = useLibraryStore(
        (s) => s.cropAndReplaceFileOptimistic,
    );
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

    const handleScan = useCallback(async (): Promise<void> => {
        const generation = ++scanGenerationRef.current;
        setScanning(true);
        setError(undefined);
        setResultMessage(undefined);
        setCandidates([]);
        const croppable = files.filter(
            (file) => canCrop(file) && !isFileArchivedLocally(file),
        );

        const isCancelled = (): boolean =>
            generation !== scanGenerationRef.current;

        try {
            setStatusLine("Scanning cached thumbnails…");
            setProgress({ current: 0, total: croppable.length });
            const likelyIds: number[] = [];
            let thumbDone = 0;
            let idbHits = 0;
            let skippedUncached = 0;
            let lastProgressAt = 0;

            await mapBatched(
                croppable,
                async (file) => {
                    if (isCancelled()) {
                        return;
                    }
                    try {
                        const thumbBytes =
                            await loadCachedDecryptedThumbnailBytes(file);
                        if (!thumbBytes) {
                            skippedUncached += 1;
                            return;
                        }
                        idbHits += 1;
                        if (isCancelled()) {
                            return;
                        }
                        const hasBorder = await thumbHasBorderInWorker(
                            file.id,
                            thumbBytes,
                        );
                        if (hasBorder) {
                            likelyIds.push(file.id);
                        }
                    } catch {
                        // Skip undecryptable / undecodable thumbs.
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
                        if (thumbDone % 8 === 0) {
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
            if (!found.length) {
                setResultMessage(
                    skippedUncached > 0 ?
                        `No borders in ${idbHits} cached thumbs (${skippedUncached} not cached yet — browse the gallery to cache more, then re-scan).` :
                        "No black borders found.",
                );
            } else if (skippedUncached > 0) {
                setResultMessage(
                    `Found ${found.length} likely letterboxed (thumb scan). Skipped ${skippedUncached} without local thumbs. Crop verifies each at full res.`,
                );
            } else {
                setResultMessage(
                    `Found ${found.length} likely letterboxed images. Crop verifies each at full resolution.`,
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
    }, [files]);

    const handleApply = useCallback(async (): Promise<void> => {
        if (!candidates.length) {
            return;
        }
        const generation = ++scanGenerationRef.current;
        setApplying(true);
        setError(undefined);
        setProgress({ current: 0, total: candidates.length });
        let succeeded = 0;
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
                        );
                        void finalize.catch(() => {
                            // Store path handles revert/toast.
                        });
                        succeeded += 1;
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
                `Queued ${succeeded} of ${candidates.length} image${
                    candidates.length === 1 ? "" : "s"
                } for crop.`,
            );
            setCandidates([]);
        } finally {
            if (generation === scanGenerationRef.current) {
                setApplying(false);
            }
        }
    }, [candidates, cropAndReplaceFileOptimistic]);

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

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
            <p className="text-sm text-muted-foreground">
                Scans locally cached thumbnails only, then lists likely
                letterboxed images. Full-resolution verify + crop happens when
                you tap Crop (one at a time). Browse the gallery first to cache
                more thumbs.
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
