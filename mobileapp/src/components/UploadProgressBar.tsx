import type { JSX } from "react";
import { Progress } from "@/components/ui/progress";
import { useUploadJobStore } from "@/stores/ui-store";

/**
 * Global upload progress shown above the app header while batch uploads run.
 */
export function UploadProgressBar(): JSX.Element | null {
    const status = useUploadJobStore((s) => s.status);
    const progress = useUploadJobStore((s) => s.progress);
    const setPanelOpen = useUploadJobStore((s) => s.setPanelOpen);

    if (status !== "running") {
        return null;
    }

    const { current, total } = progress;
    const progressValue =
        total > 0 ? Math.round((current / total) * 100) : undefined;

    return (
        <button
            type="button"
            className="w-full border-b border-border bg-background px-4 py-2 text-left transition-colors hover:bg-muted/50 active:bg-muted"
            aria-label="Open upload panel"
            onClick={() => setPanelOpen(true)}
        >
            <p className="mb-1.5 text-xs text-muted-foreground">
                {total > 0 ?
                    `Uploading ${current} of ${total} · tap to view` :
                    "Uploading… · tap to view"}
            </p>
            <Progress
                value={progressValue ?? 0}
                className="pointer-events-none h-1"
            />
        </button>
    );
}
