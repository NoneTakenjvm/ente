import type { JSX } from "react";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";

interface PageLoaderProps {
    message: string;
    /** Secondary line under the message (e.g. photo count). */
    detail?: string;
    /** Optional determinate progress; omit for indeterminate spinner-only. */
    progress?: { current: number; total: number };
}

export function PageLoader({
    message,
    detail,
    progress,
}: PageLoaderProps): JSX.Element {
    const showBar =
        progress !== undefined &&
        progress.total > 0 &&
        Number.isFinite(progress.current) &&
        Number.isFinite(progress.total);
    const percent = showBar ?
        Math.max(
            0,
            Math.min(100, Math.round((progress.current / progress.total) * 100)),
        ) :
        0;

    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <Spinner className="size-6" />
            <p className="text-sm text-muted-foreground">{message}</p>
            {detail ? (
                <p className="text-xs text-muted-foreground/80">{detail}</p>
            ) : null}
            {showBar ? (
                <div className="w-full max-w-xs pt-1" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                    <Progress value={percent} />
                </div>
            ) : null}
        </div>
    );
}
