import { useMemo, type JSX } from "react";
import { ArchiveRestore } from "lucide-react";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import { useGridSelection } from "@/hooks/use-grid-selection";
import { dedupeFilesById } from "@/lib/sync/merge-files";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import { sortFilesByUpload } from "@/lib/sort-files";
import { useLibraryStore } from "@/stores/library-store";
import type { EnteFile } from "ente-media/file";
import { plural } from "@/lib/format";

interface ManageArchivedPanelProps {
    files: EnteFile[];
}

/**
 * List archived files and allow unarchiving them.
 */
export function ManageArchivedPanel({
    files,
}: ManageArchivedPanelProps): JSX.Element {
    const batchSetArchived = useLibraryStore((s) => s.batchSetArchived);

    const archivedFiles = useMemo(() => {
        const deduped = dedupeFilesById(files).filter(
            (file) => isFileArchivedLocally(file),
        );
        return sortFilesByUpload(deduped);
    }, [files]);

    const { selectedIds, selection, busy, actionError, runBusy } =
        useGridSelection(archivedFiles);

    const handleUnarchiveSelected = (): void => {
        if (selectedIds.size === 0) {
            return;
        }
        void runBusy(
            () => batchSetArchived([...selectedIds], false),
            "Could not unarchive",
        );
    };

    if (archivedFiles.length === 0) {
        return (
            <Empty className="flex-1 border-0">
                <EmptyHeader>
                    <EmptyTitle>No archived images</EmptyTitle>
                    <EmptyDescription>
                        Archived photos will appear here so you can restore them.
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            <p className="shrink-0 px-4 pt-3 text-xs text-muted-foreground">
                {plural(archivedFiles.length, "archived image")}
            </p>
            {actionError ? (
                <Alert variant="destructive" className="mx-4 shrink-0">
                    <AlertDescription>{actionError}</AlertDescription>
                </Alert>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col px-2">
                <ThumbnailGrid
                    files={archivedFiles}
                    selection={selection}
                />
            </div>
            {selectedIds.size > 0 ? (
                <footer className="shrink-0 border-t border-border px-4 py-3">
                    <Button
                        type="button"
                        className="w-full gap-2"
                        disabled={busy}
                        onClick={handleUnarchiveSelected}
                    >
                        <ArchiveRestore className="size-4" />
                        Unarchive ({selectedIds.size})
                    </Button>
                </footer>
            ) : null}
        </div>
    );
}
