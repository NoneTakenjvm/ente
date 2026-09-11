import type { JSX } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useLibraryStore } from "@/stores/library-store";

export function SyncBanner(): JSX.Element | null {
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const syncProgress = useLibraryStore((s) => s.syncProgress);
    const syncError = useLibraryStore((s) => s.syncError);
    const syncRemote = useLibraryStore((s) => s.syncRemote);
    const forceResyncLibrary = useLibraryStore((s) => s.forceResyncLibrary);

    if (syncStatus === "offline") {
        return (
            <Alert className="mx-4 mt-3 rounded-lg border-border/60 py-2">
                <AlertDescription>
                    Offline — showing cached library
                </AlertDescription>
            </Alert>
        );
    }

    if (syncStatus === "error" && syncError) {
        return (
            <Alert variant="destructive" className="mx-4 mt-3 rounded-lg py-2">
                <AlertDescription className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1">
                        Sync failed: {syncError}
                    </span>
                    <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                            void syncRemote();
                        }}
                        onContextMenu={(event) => {
                            event.preventDefault();
                            void forceResyncLibrary();
                        }}
                        title="Tap to retry · long-press / right-click to force full resync"
                    >
                        Retry
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }

    if (syncStatus !== "syncing" && syncStatus !== "loadingFromCache") {
        return null;
    }

    const { current, total } = syncProgress;
    const label: string =
        syncStatus === "loadingFromCache" ?
            "Loading from encrypted cache…" :
            total > 0 ?
                `Syncing album ${current} of ${total}…` :
                "Syncing your library…";
    const progressValue =
        total > 0 ? Math.round((current / total) * 100) : undefined;

    return (
        <div
            className="mx-4 mt-3 flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2"
            role="status"
        >
            <span className="text-xs text-muted-foreground">{label}</span>
            {progressValue !== undefined ? (
                <Progress value={progressValue} className="h-1" />
            ) : null}
        </div>
    );
}
