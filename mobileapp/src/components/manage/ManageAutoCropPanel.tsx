import { useEffect, useState, type JSX } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import { useJob } from "@/hooks/use-job";
import {
    AUTO_CROP_BATCH_SIZE,
    AUTO_CROP_BATCH_SIZE_UNDER_PRESSURE,
    autoCropEligibleFiles,
    runAutoCropApply,
    runAutoCropScan,
    type AutoCropProgress,
} from "@/lib/auto-crop-job";
import { terminateBorderScanWorker } from "@/lib/border-scan-job";
import { jobPercent } from "@/lib/job-utils";
import type { EnteFile } from "ente-media/file";
import { errorMessage, plural } from "@/lib/format";

interface ManageAutoCropPanelProps {
    files: EnteFile[];
}

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
    const scanJob = useJob<AutoCropProgress>();
    const applyJob = useJob<AutoCropProgress>();
    const [candidates, setCandidates] = useState<EnteFile[]>([]);
    const [error, setError] = useState<string | undefined>();
    const [resultMessage, setResultMessage] = useState<string | undefined>();

    useEffect(() => {
        return (): void => {
            terminateBorderScanWorker();
        };
    }, []);

    const scanning = scanJob.status === "running";
    const applying = applyJob.status === "running";

    const handleScan = (): void => {
        setError(undefined);
        setResultMessage(undefined);
        setCandidates([]);
        scanJob.start(
            (signal, onProgress) => runAutoCropScan(files, signal, onProgress),
            {
                onFinish: (result, aborted) => {
                    if (!aborted) {
                        setCandidates(result.found);
                        setResultMessage(result.message);
                    }
                },
                onError: (scanError) => {
                    setError(errorMessage(scanError, "Scan failed"));
                },
            },
        );
    };

    const handleApply = (): void => {
        if (!candidates.length) {
            return;
        }
        setError(undefined);
        applyJob.start(
            (signal, onProgress) =>
                runAutoCropApply(candidates, signal, onProgress),
            {
                onFinish: (message, aborted) => {
                    if (!aborted) {
                        setResultMessage(message);
                        setCandidates([]);
                    }
                },
            },
        );
    };

    const handleCancel = (): void => {
        scanJob.reset();
        applyJob.reset();
        terminateBorderScanWorker();
    };

    const progress = scanning ? scanJob.progress : applyJob.progress;

    const eligibleRemaining = autoCropEligibleFiles(files).length;

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
                    onClick={handleScan}
                    disabled={scanning || applying || files.length === 0}
                >
                    {scanning ? "Scanning…" : "Scan for borders"}
                </Button>
                <Button
                    type="button"
                    variant="secondary"
                    onClick={handleApply}
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
            {progress && (scanning || applying) ? (
                <div className="flex flex-col gap-1">
                    <Progress
                        value={jobPercent(progress.current, progress.total)}
                        className="h-1"
                    />
                    <span className="text-xs text-muted-foreground">
                        {progress.label ? `${progress.label} ` : null}
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
                    {plural(candidates.length, "image")} with borders ready to
                    crop.
                </p>
            ) : null}
        </div>
    );
}
