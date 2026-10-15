import type { JSX, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { BackgroundJobStatus, JobProgress } from "@/hooks/use-job";
import { jobPercent } from "@/lib/job-utils";

interface JobControlsProps {
    status: BackgroundJobStatus;
    progress: JobProgress | undefined;
    /** Start button label before the job has run. */
    startLabel: string;
    /** Start button label after the job was paused. */
    resumeLabel: string;
    /** Nothing left to scan: the start button reads "Scan complete" and is disabled. */
    complete: boolean;
    /** Extra reason to disable the start button (indexes still loading, ...). */
    disabled?: boolean;
    /** Shown before the progress count. */
    progressLabel?: string;
    size?: "default" | "sm";
    variant?: "default" | "outline";
    onStart: () => void;
    onPause: () => void;
    /** Extra buttons shown in the same row. */
    children?: ReactNode;
}

/** Start / Resume / Pause buttons with a progress bar while the job runs. */
export function JobControls({
    status,
    progress,
    startLabel,
    resumeLabel,
    complete,
    disabled = false,
    progressLabel = "Scanning",
    size = "default",
    variant = "outline",
    onStart,
    onPause,
    children,
}: JobControlsProps): JSX.Element {
    const running = status === "running";
    return (
        <>
            <div className="flex flex-wrap gap-2">
                <Button
                    type="button"
                    size={size}
                    variant={variant}
                    disabled={running || complete || disabled}
                    onClick={onStart}
                >
                    {complete ?
                        "Scan complete" :
                        status === "paused" ?
                            resumeLabel :
                            startLabel}
                </Button>
                {running ? (
                    <Button
                        type="button"
                        size={size}
                        variant="outline"
                        onClick={onPause}
                    >
                        Pause
                    </Button>
                ) : null}
                {children}
            </div>
            {running && progress ? (
                <div className="flex flex-col gap-1">
                    <Progress
                        value={jobPercent(progress.current, progress.total)}
                        className="h-1"
                    />
                    <span className="text-xs text-muted-foreground">
                        {progressLabel} {progress.current} / {progress.total}
                    </span>
                </div>
            ) : null}
        </>
    );
}
