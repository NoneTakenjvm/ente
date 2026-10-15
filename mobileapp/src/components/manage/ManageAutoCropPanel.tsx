import { useEffect, useState, type JSX } from "react";
import { JobControls } from "@/components/manage/JobControls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import { useJob } from "@/hooks/use-job";
import {
    AUTO_CROP_BATCH_SIZE,
    autoCropEligibleFiles,
    runAutoCrop,
    type AutoCropProgress,
} from "@/lib/auto-crop-job";
import { terminateBorderScanWorker } from "@/lib/border-scan-job";
import type { EnteFile } from "ente-media/file";
import { errorMessage } from "@/lib/format";

interface ManageAutoCropPanelProps {
    files: EnteFile[];
}

/**
 * Find images with black borders and crop them, batch after batch, until all
 * eligible images are done or the user pauses.
 *
 * Fetches missing thumbnails on demand. Files with no border (or after a
 * successful crop) get a hidden `auto-cropped` tag so later runs skip them.
 */
export function ManageAutoCropPanel({
    files,
}: ManageAutoCropPanelProps): JSX.Element {
    const job = useJob<AutoCropProgress>();
    const [error, setError] = useState<string | undefined>();
    const [resultMessage, setResultMessage] = useState<string | undefined>();

    useEffect(() => {
        return (): void => {
            terminateBorderScanWorker();
        };
    }, []);

    const handleStart = (): void => {
        setError(undefined);
        setResultMessage(undefined);
        job.start(
            (signal, onProgress) => runAutoCrop(files, signal, onProgress),
            {
                onFinish: (message) => {
                    setResultMessage(message);
                },
                onError: (runError) => {
                    setError(errorMessage(runError, "Auto-crop failed"));
                },
            },
        );
    };

    const running = job.status === "running";
    const eligibleRemaining = autoCropEligibleFiles(files).length;

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
            <p className="text-sm text-muted-foreground">
                Scans {AUTO_CROP_BATCH_SIZE} images at a time for black borders
                and crops the ones it finds, until every image is done or you
                pause. Missing thumbnails are downloaded during the scan. Images
                without borders are marked internally so they are not scanned
                again
                {eligibleRemaining > 0 ?
                    ` (${eligibleRemaining} still eligible).` :
                    "."}
            </p>
            <JobControls
                status={job.status}
                progress={job.progress}
                startLabel="Start auto-crop"
                resumeLabel="Resume auto-crop"
                complete={eligibleRemaining === 0}
                disabled={files.length === 0}
                progressLabel={job.progress?.label}
                variant="default"
                onStart={handleStart}
                onPause={job.pause}
            />
            {running && job.progress ? (
                <p className="text-sm">{job.progress.cropped} cropped so far.</p>
            ) : null}
            {error ? (
                <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            ) : null}
            {resultMessage && !running ? (
                <p className="text-sm text-muted-foreground">{resultMessage}</p>
            ) : null}
            {job.status === "idle" ? (
                <Empty className="flex-1 border-0">
                    <EmptyHeader>
                        <EmptyTitle>Ready to auto-crop</EmptyTitle>
                        <EmptyDescription>
                            Start to find and crop images with black borders.
                        </EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : null}
        </div>
    );
}
