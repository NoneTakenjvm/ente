import { useMemo, useState, type JSX } from "react";
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
import { dedupeFilesById } from "@/lib/sync/merge-files";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import { fileCreationTime } from "ente-media/file-metadata";
import { useLibraryStore } from "@/stores/library-store";
import type { EnteFile } from "ente-media/file";

interface ManageArchivedPanelProps {
    files: EnteFile[];
}

/**
 * List archived files and allow unarchiving them.
 */
export function ManageArchivedPanel({
    files,
}: ManageArchivedPanelProps): JSX.Element {
    const setFileArchived = useLibraryStore((s) => s.setFileArchived);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [busy, setBusy] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>();

    const archivedFiles = useMemo(() => {
        const deduped = dedupeFilesById(files).filter(
            (file) => isFileArchivedLocally(file),
        );
        return [...deduped].sort(
            (a, b) => fileCreationTime(b) - fileCreationTime(a),
        );
    }, [files]);

    const handleToggle = (file: EnteFile): void => {
        setSelectedIds((current) => {
            const next = new Set(current);
            if (next.has(file.id)) {
                next.delete(file.id);
            } else {
                next.add(file.id);
            }
            return next;
        });
    };

    const handleUnarchiveSelected = (): void => {
        const targets = archivedFiles.filter((file) =>
            selectedIds.has(file.id));
        if (!targets.length) {
            return;
        }
        setBusy(true);
        setError(undefined);
        void Promise.all(
            targets.map((file) => setFileArchived(file, false)),
        )
            .then(() => {
                setSelectedIds(new Set());
            })
            .catch((unarchiveError: unknown) => {
                setError(
                    unarchiveError instanceof Error ?
                        unarchiveError.message :
                        "Could not unarchive",
                );
            })
            .finally(() => {
                setBusy(false);
            });
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
                {archivedFiles.length} archived image
                {archivedFiles.length === 1 ? "" : "s"}
            </p>
            {error ? (
                <Alert variant="destructive" className="mx-4 shrink-0">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col px-2">
                <ThumbnailGrid
                    files={archivedFiles}
                    selection={{
                        selectedIds,
                        onToggle: handleToggle,
                        disabled: busy,
                    }}
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
