import type { JSX } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useBatchApplyStore } from "@/stores/batch-apply-store";

/**
 * Progress for mass crop/rotate batches applying in the background: one line
 * per running batch, and a retry/dismiss alert for batches that had failures.
 */
export function BatchApplyBanner(): JSX.Element | null {
    const batches = useBatchApplyStore((s) => s.batches);
    const dismiss = useBatchApplyStore((s) => s.dismiss);

    if (batches.length === 0) {
        return null;
    }

    return (
        <>
            {batches.map((batch) => {
                const finished = batch.done + batch.failed;
                if (batch.running) {
                    return (
                        <div
                            key={batch.id}
                            className="mx-4 mt-3 flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2"
                            role="status"
                        >
                            <span className="text-xs text-muted-foreground">
                                {batch.verb.active} {finished} of {batch.total}…
                            </span>
                            <Progress
                                value={Math.round((finished / batch.total) * 100)}
                                className="h-1"
                            />
                        </div>
                    );
                }
                return (
                    <Alert
                        key={batch.id}
                        variant="destructive"
                        className="mx-4 mt-3 rounded-lg py-2"
                    >
                        <AlertDescription className="flex flex-wrap items-center gap-2">
                            <span className="min-w-0 flex-1">
                                {batch.verb.past} {batch.done}, {batch.failed}{" "}
                                failed
                            </span>
                            <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                onClick={batch.retry}
                            >
                                Retry
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => dismiss(batch.id)}
                            >
                                Dismiss
                            </Button>
                        </AlertDescription>
                    </Alert>
                );
            })}
        </>
    );
}
